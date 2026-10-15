import { Rating } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiWord } from '../../shared/api.ts';
import { db } from '../lib/db.ts';
import type { WordRef } from '../lib/types.ts';
import { introduceItem } from './items.ts';
import { knownWordsFrom } from './readListen.ts';
import { gradeCard } from './scheduler.ts';
import { createGuardedCloze, grammarMarkersIn, guardSentence, type GuardContext, type GuardInput } from './sentenceGuard.ts';
import { at, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const w = (surface: string, lemma = surface, reading = surface): AiWord => ({ surface, lemma, reading });

const LEXICON: Record<string, WordRef> = {
  '日本': 'word:1002',
  'にほん': 'word:1002',
  '本': 'word:1006',
  '人': 'word:1007',
  '書く': 'word:9001',
  '読む': 'word:9002',
  '食べる': 'word:9003',
};

function ctx(introduced: string[], grammar: string[] = [], today = '2026-03-20'): GuardContext {
  const map = new Map(introduced.map((ref) => [ref, '2026-03-15']));
  return {
    lookup: (form) => LEXICON[form],
    known: knownWordsFrom(map, new Set(introduced)),
    grammarKnown: new Set(grammar),
    today,
  };
}

const input = (corrected: string, words: AiWord[], patch: Partial<GuardInput> = {}): GuardInput => ({
  corrected, en: '', words, grammarUsed: [], ...patch,
});

describe('guardSentence', () => {
  it('passes a sentence of known words and introduced grammar, blanking the target', () => {
    const result = guardSentence(
      input('{日本|にほん}の{本|ほん}です。', [w('日本', '日本', 'にほん'), w('の'), w('本', '本', 'ほん'), w('です'), w('。')], { target: 'word:1006' }),
      ctx(['word:1002', 'word:1006']),
    );
    expect(result).toEqual({ ok: true, reasons: [], blank: { surface: '本', reading: 'ほん', ref: 'word:1006' } });
  });

  it('fails on a word that is not introduced or not in the dictionary', () => {
    const words = [w('日本', '日本', 'にほん'), w('の'), w('本', '本', 'ほん'), w('です')];
    expect(guardSentence(input('日本の本です', words), ctx(['word:1002'])).ok).toBe(false);
    const unknown = guardSentence(input('日本の猫です', [w('日本'), w('の'), w('猫', '猫', 'ねこ'), w('です')]), ctx(['word:1002']));
    expect(unknown.reasons).toContain('unknown word: 猫');
  });

  it('fails when the model leaves an unknown word out of its list', () => {
    const result = guardSentence(input('日本の猫です', [w('日本'), w('の'), w('です')]), ctx(['word:1002']));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('the word list does not cover the sentence');
    const invented = guardSentence(input('日本です', [w('日本'), w('です'), w('本')]), ctx(['word:1002', 'word:1006']));
    expect(invented.ok).toBe(false);
  });

  it('finds untaught grammar in the text itself, whatever the model says', () => {
    const passive = input('本を書かれた', [w('本'), w('を'), w('書かれた', '書く', 'かかれた')]);
    const result = guardSentence(passive, ctx(['word:1006', 'word:9001']));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('grammar not introduced: passive');
    expect(guardSentence(passive, ctx(['word:1006', 'word:9001'], ['passive'])).ok).toBe(true);
  });

  it("fails when grammarUsed names 'other' or an untaught point, and can never pass a sentence by itself", () => {
    const sentence = input('日本です', [w('日本'), w('です')]);
    expect(guardSentence({ ...sentence, grammarUsed: ['other'] }, ctx(['word:1002'])).ok).toBe(false);
    expect(guardSentence({ ...sentence, grammarUsed: ['te-form'] }, ctx(['word:1002'])).ok).toBe(false);
    expect(guardSentence({ ...sentence, grammarUsed: ['te-form'] }, ctx(['word:1002'], ['te-form'])).ok).toBe(true);
  });
});

describe('grammar markers', () => {
  it.each([
    ['本を書かれた', 'passive'],
    ['子どもに食べさせる', 'causative'],
    ['読めば', 'ba-conditional'],
    ['雨が降ったら行かない', 'tara-conditional'],
    ['日本なら', 'nara'],
    ['読んでも分からない', 'temo-even-if'],
    ['おいしそうです', 'sou-looks'],
    ['雨が降るそうです', 'sou-hearsay'],
    ['猫みたいだ', 'you-da'],
    ['食べてしまった', 'te-shimau'],
    ['食べちゃった', 'te-shimau'],
    ['買っておく', 'te-oku'],
    ['食べてみる', 'te-miru'],
    ['歩きながら', 'nagara'],
    ['行くつもりです', 'tsumori'],
    ['雨かもしれない', 'kamoshirenai'],
    ['行かなければならない', 'nakereba-naranai'],
    ['食べられる', 'potential-form'],
    ['行こう。', 'volitional'],
    ['食べたり飲んだりする', 'tari-tari'],
    ['食べすぎた', 'sugiru'],
  ])('%s → %s', (text, id) => {
    expect(grammarMarkersIn(text)).toContain(id);
  });

  it('stays quiet on everyday sentences', () => {
    for (const text of ['ありがとう。', 'おはよう。', 'そうですね。', 'はい、そうです。', 'きのう、日本に行きました。', 'とても大きいです。', 'どう？']) {
      expect(grammarMarkersIn(text), text).toEqual([]);
    }
  });
});

describe('createGuardedCloze', () => {
  it('saves the sentence and creates one cloze card when the guard passes', async () => {
    const now = at(2026, 3, 20, 9);
    await introduceItem('word', '1002', at(2026, 3, 10));
    await introduceItem('word', '1006', at(2026, 3, 10));
    await gradeCard('word:1006|read', Rating.Good, { durationMs: 1, mode: 'typed', now: at(2026, 3, 11) });
    const guarded = input('{日本|にほん}の{本|ほん}です。', [w('日本', '日本', 'にほん'), w('の'), w('本', '本', 'ほん'), w('です'), w('。')], { en: 'A Japanese book.' });
    const cardId = await createGuardedCloze(guarded, 'correction', now);
    expect(cardId).toMatch(/^sentence:custom-.+\|cloze$/);
    const [saved] = await db.savedSentences.toArray();
    expect(saved).toMatchObject({ jp: '{日本|にほん}の{本|ほん}です。', en: 'A Japanese book.', source: 'correction', blank: { surface: '本', reading: 'ほん', ref: 'word:1006' } });
    expect(await createGuardedCloze(guarded, 'correction', now)).toBe(cardId);
    expect(await db.savedSentences.count()).toBe(1);
  });

  it('creates nothing when a word is unknown', async () => {
    const result = await createGuardedCloze(input('猫です', [w('猫', '猫', 'ねこ'), w('です')]), 'recap', at(2026, 3, 20));
    expect(result).toBeNull();
    expect(await db.cards.count()).toBe(0);
  });
});
