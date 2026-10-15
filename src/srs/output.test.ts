import { Rating } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCheckResponse } from '../../shared/api.ts';
import { dayKey, db } from '../lib/db.ts';
import type { ItemRecord } from '../lib/types.ts';
import { addDays, DAY_MS, emptyDay } from './days.ts';
import { logEncounters } from './encounters.ts';
import { introduceItem } from './items.ts';
import { completeOutputCheck, learnerAiContext, pendingOutputChecks, pickOutputTarget, saveOutput } from './output.ts';
import { gradeCard } from './scheduler.ts';
import { at, BASIC_HIRAGANA, BASIC_KATAKANA, resetDb, RULES } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const NOW = at(2026, 3, 20, 9);
const TODAY = dayKey(NOW);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** Today is course day n, the sprint complete. */
async function seed(n: number) {
  await db.days.bulkPut(Array.from({ length: n - 1 }, (_, i) => ({ ...emptyDay(addDays(TODAY, -(i + 1))), reviews: 1 })));
  await db.items.bulkPut([
    ...[...BASIC_HIRAGANA, ...BASIC_KATAKANA].map((c): ItemRecord => ({ id: `kana:${c}`, kind: 'kana', key: c, introducedAt: ago(n) })),
    ...RULES.map((r): ItemRecord => ({ id: `kanaRule:${r.id}`, kind: 'kanaRule', key: r.id, introducedAt: ago(n) })),
  ]);
}

describe('pickOutputTarget', () => {
  it('has no target before the sprint is over', async () => {
    await db.days.bulkPut(Array.from({ length: 9 }, (_, i) => ({ ...emptyDay(addDays(TODAY, -(i + 1))), reviews: 1 })));
    await introduceItem('core', 'cw-0001', ago(2));
    expect(await pickOutputTarget(NOW)).toBeNull();
  });

  it('picks a recent word with a produce card, the least practised first', async () => {
    await seed(20); // day 20: a word day
    await introduceItem('word', '1002', ago(3)); // 日本, use
    await introduceItem('word', '1007', ago(2)); // 人, use
    await introduceItem('word', '1001', ago(1)); // 日, no use
    await introduceItem('core', 'cw-0005', ago(8)); // too old
    await logEncounters(['word:1007'], 'output', ago(1));
    expect(await pickOutputTarget(NOW)).toEqual({ ref: 'word:1002', label: '{日本|にほん}', en: 'Japan' });
  });

  it('shows a core word in kana until it is spelled', async () => {
    await seed(20);
    await introduceItem('core', 'cw-0044', ago(2), { ctx: { use: true } });
    expect(await pickOutputTarget(NOW)).toMatchObject({ ref: 'core:cw-0044', label: 'ひと' });
  });

  it('uses a recent grammar point every third study day', async () => {
    await seed(21);
    await introduceItem('word', '1002', ago(3));
    await introduceItem('grammar', 'wa-desu', ago(10));
    await introduceItem('grammar', 'passive', ago(2)); // recognition only
    expect(await pickOutputTarget(NOW)).toEqual({ ref: 'grammar:wa-desu', label: '〜wa-desu', en: 'wa-desu' });
  });
});

describe('the output check', () => {
  const response = (patch: Partial<AiCheckResponse> = {}): AiCheckResponse => ({
    ok: false, issues: [], corrected: '日本の本です。', correctedRuby: '{日本|にほん}の{本|ほん}です。', diff: [], rule: 'の links two nouns.',
    grammarUsed: [], tips: [],
    words: [{ surface: '日本', lemma: '日本', reading: 'にほん' }, { surface: 'の', lemma: 'の', reading: 'の' }, { surface: '本', lemma: '本', reading: 'ほん' }, { surface: 'です', lemma: 'です', reading: 'です' }],
    ...patch,
  });

  it('queues a check, then stores the result and the cloze card once', async () => {
    await introduceItem('word', '1002', ago(10));
    await introduceItem('word', '1006', ago(3));
    await gradeCard('word:1002|read', Rating.Good, { durationMs: 1, mode: 'typed', now: ago(9) });
    const row = await saveOutput({ day: TODAY, target: { ref: 'word:1006', label: '{本|ほん}', en: 'book' }, draft: '日本本です', text: '日本本です', check: 'pending' }, NOW);
    expect((await pendingOutputChecks()).map((r) => r.id)).toEqual([row.id]);
    const { cardId } = await completeOutputCheck(row.id, response(), NOW);
    expect(cardId).toMatch(/\|cloze$/);
    const stored = await db.outputs.get(row.id);
    expect(stored).toMatchObject({ check: 'done', corrected: '{日本|にほん}の{本|ほん}です。', rule: 'の links two nouns.', cardId });
    expect((await db.savedSentences.toArray())[0].blank).toEqual({ surface: '本', reading: 'ほん', ref: 'word:1006' });
    expect(await completeOutputCheck(row.id, response(), NOW)).toEqual({ cardId });
    expect(await pendingOutputChecks()).toEqual([]);
  });

  it("gives the cloze card the sentence's translation, never the day's target gloss (QA V052)", async () => {
    await introduceItem('word', '1002', ago(10));
    await introduceItem('word', '1006', ago(3));
    await gradeCard('word:1002|read', Rating.Good, { durationMs: 1, mode: 'typed', now: ago(9) });
    const target = { ref: 'word:1006', label: '{本|ほん}', en: '〜ました・〜ませんでした — "did", "didn\'t"' };
    const translated = await saveOutput({ day: TODAY, target, draft: '日本本です', text: '日本本です', check: 'pending' }, NOW);
    await completeOutputCheck(translated.id, response({ en: " It's a book about Japan. " }), NOW);
    expect((await db.savedSentences.toArray()).map((s) => s.en)).toEqual(["It's a book about Japan."]);

    // An older server sends no translation: the card has no English line rather than a wrong one.
    await db.savedSentences.clear();
    await db.items.where('kind').equals('sentence').delete();
    const bare = await saveOutput({ day: TODAY, target, draft: 'x', text: 'x', check: 'pending' }, NOW);
    await completeOutputCheck(bare.id, response(), NOW);
    expect((await db.savedSentences.toArray()).map((s) => s.en)).toEqual(['']);
  });

  it('saves a send once, even when saved twice (double tap or a StrictMode re-run)', async () => {
    const target = { ref: 'word:1006', label: '本', en: 'book' };
    const sent = { day: TODAY, target, draft: '本です', text: '本です', check: 'pending' as const, chatClientId: 'client-1' };
    const [a, b] = await Promise.all([saveOutput(sent, NOW), saveOutput(sent, NOW)]);
    expect(b.id).toBe(a.id);
    expect(await db.outputs.count()).toBe(1);
    // Without a chat clientId the same draft and text that day is the same send; another clientId is another send.
    const local = { day: TODAY, target, draft: 'x', text: 'x', check: 'unavailable' as const };
    expect((await saveOutput(local, NOW)).id).toBe((await saveOutput(local, NOW)).id);
    await saveOutput({ ...sent, chatClientId: 'client-2' }, NOW);
    expect(await db.outputs.count()).toBe(3);
  });

  it('stores the result without a card when the guard fails', async () => {
    const row = await saveOutput({ day: TODAY, target: { ref: 'word:1006', label: '本', en: 'book' }, draft: 'x', text: 'x', check: 'pending' }, NOW);
    expect(await completeOutputCheck(row.id, response(), NOW)).toEqual({});
    expect((await db.outputs.get(row.id))?.check).toBe('done');
    expect(await db.cards.count()).toBe(0);
  });

  it('describes what the learner knows for the AI', async () => {
    await introduceItem('kanji', '日', ago(5));
    await introduceItem('grammar', 'wa-desu', ago(5));
    await introduceItem('word', '1002', ago(5));
    await introduceItem('core', 'cw-0044', ago(5));
    await gradeCard('word:1002|read', Rating.Good, { durationMs: 1, mode: 'typed', now: ago(4) });
    await gradeCard('core:cw-0044|listen', Rating.Good, { durationMs: 1, mode: 'self', now: ago(4) });
    expect(await learnerAiContext(NOW)).toEqual({ knownKanji: ['日'], knownGrammar: ['wa-desu'], knownWords: ['ひと', '日本'], register: 'plain' });
  });
});
