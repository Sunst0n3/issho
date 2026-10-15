// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { JmEntry, JmSense } from './lib/jmdict.ts';
import { coreAltKana, entryAltKana, longVowelVariants, nfRank, priorityTags, selectWord, usesOnlyJoyo } from './lib/words.ts';

const JOYO = new Set([...'水曜日上下手何事為奇麗今人見食']);
const isJoyo = (ch: string) => JOYO.has(ch);

function sense(glosses: string[], extra: Partial<JmSense> = {}): JmSense {
  return { stagk: [], stagr: [], pos: ['n'], misc: [], glosses, ...extra };
}

function entry(partial: Partial<JmEntry>): JmEntry {
  return { id: '1', kanji: [], readings: [], senses: [sense(['thing'])], ...partial };
}

const k = (text: string, pri: string[] = [], info: string[] = []) => ({ text, pri, info });
const r = (text: string, extra: { pri?: string[]; restr?: string[]; info?: string[]; noKanji?: boolean } = {}) => ({
  text,
  pri: extra.pri ?? [],
  restr: extra.restr ?? [],
  info: extra.info ?? [],
  noKanji: extra.noKanji ?? false,
});

describe('selectWord', () => {
  it('builds a WordEntry from the first common kanji spelling', () => {
    const selected = selectWord(
      entry({
        id: '1371260',
        kanji: [k('水曜日', ['ichi1', 'news1', 'nf03'])],
        readings: [r('すいようび', { pri: ['ichi1'] })],
        senses: [sense(['Wednesday (day of week)'], { pos: ['n', 'adv'] })],
      }),
      isJoyo,
    );
    expect(selected).toEqual({
      word: {
        id: '1371260',
        written: '水曜日',
        kana: 'すいようび',
        meanings: ['Wednesday'],
        pos: ['n', 'adv'],
        freqRank: 3,
        kanji: ['水', '曜', '日'],
        pri: ['ichi1', 'news1', 'nf03'],
      },
      basic: true,
      offensive: false,
    });
  });

  it('skips uncommon entries, kana-only entries and non-jōyō spellings', () => {
    expect(selectWord(entry({ kanji: [k('水')], readings: [r('みず')] }), isJoyo)).toBeUndefined();
    expect(selectWord(entry({ readings: [r('これ', { pri: ['ichi1'] })] }), isJoyo)).toBeUndefined();
    expect(
      selectWord(entry({ kanji: [k('綺麗', ['ichi1']), k('奇麗', ['news1', 'nf20'])], readings: [r('きれい')] }), isJoyo),
    ).toBeUndefined();
  });

  it('passes over irregular or search-only spellings and readings', () => {
    const selected = selectWord(
      entry({
        kanji: [k('今日', ['ichi1'], ['sK']), k('今', ['ichi1'])],
        readings: [r('いま', { info: ['ok'], pri: ['ichi1'] }), r('こん', { pri: ['ichi1'] })],
      }),
      isJoyo,
    );
    expect(selected?.word).toMatchObject({ written: '今', kana: 'こん' });
  });

  it('takes the reading and sense that apply to the chosen spelling', () => {
    const selected = selectWord(
      entry({
        kanji: [k('上手', ['ichi1', 'news2', 'nf30'])],
        readings: [r('うわて', { restr: ['上手い'] }), r('じょうず', { pri: ['ichi1'] }), r('ジョーズ', { noKanji: true })],
        senses: [sense(['upper part'], { stagr: ['うわて'] }), sense(['skillful (at)', 'good (at)'])],
      }),
      isJoyo,
    );
    expect(selected?.word).toMatchObject({ kana: 'じょうず', meanings: ['skillful', 'good'], freqRank: 30 });
  });

  it('drops words usually written in kana unless the kanji spelling is itself very common', () => {
    const uk = (text: string, pri: string[]) =>
      selectWord(entry({ kanji: [k(text, pri)], readings: [r('x')], senses: [sense(['y'], { misc: ['uk'] })] }), isJoyo);
    expect(uk('何事', ['ichi1'])).toBeUndefined();
    expect(uk('何事', ['ichi1', 'news1', 'nf20'])).toBeUndefined();
    expect(uk('事', ['ichi1', 'news1', 'nf01'])).toBeUndefined();
    expect(uk('何事', ['news1', 'nf05'])).toBeDefined();
  });

  it('counts only neutral-register basic vocabulary as basic, and flags offensive senses', () => {
    const verb = (text: string, misc: string[]) =>
      selectWord(
        entry({ kanji: [k(text, ['ichi1', 'news2', 'nf25'])], readings: [r('x')], senses: [sense(['to eat'], { misc })] }),
        isJoyo,
      );
    expect(verb('食べる', [])?.basic).toBe(true);
    expect(verb('食う', ['male'])).toMatchObject({ basic: false, offensive: false, word: { written: '食う' } });
    expect(verb('食う', ['col'])?.basic).toBe(false);
    expect(verb('下人', ['derog'])).toMatchObject({ basic: false, offensive: true });
  });

  it('keeps every priority tag of the spelling and reading, and the other readings as altKana', () => {
    const selected = selectWord(
      entry({
        kanji: [k('今日', ['ichi1', 'news1', 'nf01'])],
        readings: [r('きょう', { pri: ['ichi1', 'spec1'] }), r('こんにち', { pri: ['news1'] }), r('きょ', { restr: ['今'] })],
      }),
      isJoyo,
    );
    expect(selected?.word).toMatchObject({ pri: ['ichi1', 'news1', 'nf01', 'spec1'], altKana: ['こんにち'] });
  });

  it('marks common words without a frequency bucket as rank 49', () => {
    const selected = selectWord(entry({ kanji: [k('人', ['ichi1'])], readings: [r('ひと')] }), isJoyo);
    expect(selected?.word.freqRank).toBe(49);
  });

  it('skips archaic and vulgar first senses', () => {
    const selected = selectWord(
      entry({ kanji: [k('見', ['spec1'])], readings: [r('み')], senses: [sense(['look'], { misc: ['arch'] })] }),
      isJoyo,
    );
    expect(selected).toBeUndefined();
  });
});

describe('word helpers', () => {
  it('spells a long vowel the other way: o-column + う/お, e-column + い/え', () => {
    expect(longVowelVariants('とおり')).toEqual(['とうり']);
    expect(longVowelVariants('せんせい')).toEqual(['せんせえ']);
    expect(longVowelVariants('コーヒー')).toEqual([]);
    expect(longVowelVariants('みず')).toEqual([]);
  });

  it('accepts alternate readings, and long-vowel variants only when JMdict lists them', () => {
    const e = entry({
      kanji: [k('通り')],
      readings: [r('とおり'), r('とうり', { info: ['ik'] }), r('みち', { info: ['sk'], pri: ['ichi1'] }), r('どおり', { restr: ['通'], pri: ['ichi1'] })],
    });
    expect(entryAltKana(e, '通り', 'とおり')).toEqual(['とうり']);
    const kanaOnly = entry({ readings: [r('こちら', { pri: ['ichi1'] }), r('こっち', { pri: ['ichi1'] })] });
    expect(entryAltKana(kanaOnly, undefined, 'こちら')).toEqual(['こっち']);
    expect(priorityTags(k('x', ['ichi1']), r('x', { pri: ['ichi1', 'spec2'] }))).toEqual(['ichi1', 'spec2']);
  });

  it('leaves out rare readings, which are often another word, and script-only variants', () => {
    // JMdict 祖父: そふ plus the untagged じじ, じい, おおじ, おじ (おじ is "uncle").
    const sofu = entry({
      kanji: [k('祖父', ['ichi1'])],
      readings: [r('そふ', { pri: ['ichi1'] }), r('じじ'), r('じい'), r('おおじ'), r('おじ')],
    });
    expect(entryAltKana(sofu, '祖父', 'そふ')).toEqual([]);
    const ashita = entry({
      kanji: [k('明日', ['ichi1'])],
      readings: [r('あした', { pri: ['ichi1'] }), r('あす', { pri: ['ichi1'] }), r('みょうにち', { pri: ['news1', 'nf05'] })],
    });
    expect(entryAltKana(ashita, '明日', 'あした')).toEqual(['あす', 'みょうにち']);
    const un = entry({ readings: [r('うん', { pri: ['spec1'] }), r('ウン', { noKanji: true, pri: ['spec1'] }), r('うむ')] });
    expect(entryAltKana(un, undefined, 'うん')).toEqual([]);
  });

  it('gives a core word the alternates of its own spelling and reading only', () => {
    const ten = entry({
      kanji: [k('十', ['ichi1'])],
      readings: [r('じゅう', { pri: ['ichi1'] }), r('とお', { pri: ['ichi1'] }), r('と')],
    });
    expect(coreAltKana({ kana: 'とお', written: '十' }, ten, new Set(['じゅう']))).toEqual([]);
    expect(coreAltKana({ kana: 'じゅう', written: '十' }, ten)).toEqual(['とお']);
    // Another spelling than the entry's, or a word the entry does not read (びっくりする on びっくり).
    expect(coreAltKana({ kana: 'せつめいする', written: '説明する' }, entry({ kanji: [k('説明')], readings: [r('せつめい')] }))).toEqual([]);
    const bikkuri = entry({ readings: [r('びっくり', { pri: ['spec1'] }), r('ビックリ', { noKanji: true })] });
    expect(coreAltKana({ kana: 'びっくりする' }, bikkuri)).toEqual([]);
    expect(coreAltKana({ kana: 'びっくり' }, undefined)).toEqual([]);
  });

  it('reads nfXX buckets', () => {
    expect(nfRank(['ichi1', 'nf07'])).toBe(7);
    expect(nfRank(['news1'])).toBeUndefined();
  });

  it('accepts only jōyō kanji, kana, ー and 々', () => {
    expect(usesOnlyJoyo('人々', isJoyo)).toBe(true);
    expect(usesOnlyJoyo('上着', isJoyo)).toBe(false);
    expect(usesOnlyJoyo('ジョー下', isJoyo)).toBe(true);
    expect(usesOnlyJoyo('Ｔシャツ', isJoyo)).toBe(false);
  });
});
