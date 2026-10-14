import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../lib/db.ts';
import type { CardRecord, SentenceEntry } from '../lib/types.ts';
import { applyKnownKana } from './course.ts';
import { DAY_MS } from './days.ts';
import { introduceItem } from './items.ts';
import {
  backlogThreshold,
  dueCount,
  estimateMinutes,
  markSentencesShown,
  orderReviews,
  pickIPlusOne,
  pickSentences,
  planToday,
  readingCountFor,
} from './planner.ts';
import { gradeCard, newCardRecord } from './scheduler.ts';
import { at, fixtures, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const NOW = at(2026, 10, 14, 9);

/** A review card for kanji:<n> that became due `daysAgo` days before NOW. */
function dueCard(n: number, daysAgo: number, patch: Partial<CardRecord> = {}): CardRecord {
  const due = new Date(NOW.getTime() - daysAgo * DAY_MS);
  return {
    ...newCardRecord(`kanji:k${n}`, 'kanji', 'meaning', due),
    state: State.Review,
    stability: 5,
    difficulty: 5,
    reps: 2,
    last_review: new Date(due.getTime() - 5 * DAY_MS),
    scheduled_days: 5,
    ...patch,
  };
}

async function addDue(count: number): Promise<void> {
  await db.cards.bulkAdd(Array.from({ length: count }, (_, i) => dueCard(i, (i % 20) + 1)));
}

describe('orderReviews', () => {
  it('puts cards still in their first steps first, then the most overdue', () => {
    const cards = [
      dueCard(1, 1),
      dueCard(2, 5),
      dueCard(3, 0.01, { state: State.Learning }),
      dueCard(4, 3),
      dueCard(5, 0.5, { state: State.Relearning }),
    ];
    expect(orderReviews(cards).map((c) => c.itemId)).toEqual(['kanji:k5', 'kanji:k3', 'kanji:k2', 'kanji:k4', 'kanji:k1']);
  });
});

describe('planToday: reviews', () => {
  it('lists due cards, most overdue first, leaving out future and suspended cards', async () => {
    await db.cards.bulkAdd([
      dueCard(1, 1),
      dueCard(2, 3),
      dueCard(3, -1), // due tomorrow
      dueCard(4, 2, { suspended: true }),
    ]);
    const plan = await planToday(NOW);
    expect(plan.reviews).toEqual(['kanji:k2|meaning', 'kanji:k1|meaning']);
    expect(plan.backlog).toBe(2);
    expect(await dueCount(NOW)).toBe(2);
  });

  it('caps reviews per day across several sessions', async () => {
    await updateSettings({ maxReviewsPerDay: 5 });
    await addDue(8);

    const morning = await planToday(NOW);
    expect(morning.reviews).toHaveLength(5);
    for (const id of morning.reviews.slice(0, 3)) {
      await gradeCard(id, Rating.Good, { durationMs: 1000, mode: 'choice', now: NOW });
    }

    const noon = await planToday(at(2026, 10, 14, 12));
    expect(noon.reviews).toHaveLength(2);
    for (const id of noon.reviews) await gradeCard(id, Rating.Good, { durationMs: 1000, mode: 'choice', now: at(2026, 10, 14, 12) });

    const evening = await planToday(at(2026, 10, 14, 21));
    expect(evening.reviews).toEqual([]);
    expect(evening.backlog).toBe(3);

    const tomorrow = await planToday(at(2026, 10, 15, 9));
    expect(tomorrow.reviews.length).toBeGreaterThanOrEqual(3);
    expect(tomorrow.reviews.length).toBeLessThanOrEqual(5);
  });
});

describe('planToday: new items', () => {
  it('offers newPerDay minus what was already introduced today', async () => {
    fixtures.survival = [];
    let plan = await planToday(NOW);
    expect(plan.newItems.map((p) => p.key)).toEqual([...'あいうえお']);
    expect(plan.newBlocked).toBeUndefined();

    await introduceItem('kana', 'あ', NOW);
    await introduceItem('kana', 'い', NOW);
    await introduceItem('word', '1001', NOW); // words don't count
    plan = await planToday(at(2026, 10, 14, 19));
    expect(plan.newItems.map((p) => p.key)).toEqual(['う', 'え', 'お']);

    await updateSettings({ newPerDay: 2 });
    expect((await planToday(at(2026, 10, 14, 20))).newItems).toEqual([]);
  });

  it('pauses new items while the backlog is too big, with a friendly reason', async () => {
    await addDue(151);
    const plan = await planToday(NOW);
    expect(plan.backlog).toBe(151);
    expect(plan.reviews).toHaveLength(120);
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked?.reason).toMatch(/151 reviews/);
  });

  it('works through a 300-card backlog a capped day at a time', async () => {
    await addDue(300);
    await db.cards.add(dueCard(999, 0.01, { state: State.Relearning }));
    const plan = await planToday(NOW);
    expect(plan.backlog).toBe(301);
    expect(plan.reviews).toHaveLength(120);
    expect(plan.reviews[0]).toBe('kanji:k999|meaning');
    const dueOf = async (id: string) => (await db.cards.get(id))!.due.getTime();
    expect(await dueOf(plan.reviews[1])).toBeLessThanOrEqual(await dueOf(plan.reviews[119]));
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked?.reason).toMatch(/301 reviews/);
  });

  it('resumes new items at the threshold', async () => {
    await addDue(150);
    const plan = await planToday(NOW);
    expect(plan.newBlocked).toBeUndefined();
    expect(plan.newItems.length).toBeGreaterThan(0);
  });

  it('uses twice the daily cap when that is lower than 150', async () => {
    expect(backlogThreshold(120)).toBe(150);
    expect(backlogThreshold(20)).toBe(40);
    await updateSettings({ maxReviewsPerDay: 20 });
    await addDue(41);
    expect((await planToday(NOW)).newBlocked).toBeDefined();
  });

  it('estimates the session length', async () => {
    await addDue(10);
    const plan = await planToday(NOW);
    expect(plan.estimateMinutes).toBe(estimateMinutes(10, plan.newItems, plan.reading.length));
    expect(plan.estimateMinutes).toBeGreaterThanOrEqual(5);
  });
});

describe('estimateMinutes', () => {
  it('rounds up and counts kanji words', () => {
    expect(estimateMinutes(0, [], 0)).toBe(0);
    expect(estimateMinutes(5, [], 0)).toBe(1);
    expect(estimateMinutes(0, [{ itemId: 'kanji:一', kind: 'kanji', key: '一', words: ['1', '2'] }], 0)).toBe(3);
  });
});

describe('pickIPlusOne', () => {
  const s = (id: string, jp: string): SentenceEntry => ({ id, jp, en: id });
  const sentences = [
    s('none', 'あおい'),
    s('known', '{一|いち}'),
    s('one-new', '{一|ひと}り{人|ひと}'),
    s('two-new', '{大|おお}きい{水|みず}'),
    s('recent', '{山|やま}'),
  ];

  it('keeps sentences with at most one unknown kanji', () => {
    const ids = pickIPlusOne(sentences, new Set(['一']), [], { allowKanaOnly: true }).map((x) => x.id);
    expect(ids).toContain('known');
    expect(ids).toContain('one-new');
    expect(ids).toContain('recent');
    expect(ids).toContain('none');
    expect(ids).not.toContain('two-new');
  });

  it('allows kana-only sentences only when asked (phase 1)', () => {
    expect(pickIPlusOne(sentences, new Set(), []).map((x) => x.id)).not.toContain('none');
    expect(pickIPlusOne(sentences, new Set(), [], { allowKanaOnly: true }).map((x) => x.id)).toContain('none');
  });

  it('prefers recently learned kanji, then a new kanji to stretch toward', () => {
    const known = new Set(['一', '山', '大']);
    const ids = pickIPlusOne(sentences, known, ['山', '一'], { allowKanaOnly: true }).map((x) => x.id);
    expect(ids).toEqual(['recent', 'one-new', 'known', 'two-new', 'none']);
  });

  it('counts unknown kana (furigana included) as new things in phase 1', () => {
    const course = new Set([...'あいうえおかきくけこちとひまみやりず']);
    const pick = (kanji: string[], kana: string) =>
      pickIPlusOne(sentences, new Set(kanji), [], { allowKanaOnly: true, kana: { course, known: new Set([...kana]) } }).map(
        (x) => x.id,
      );
    expect(pick([], 'あいうえお')).toEqual(['none']);
    expect(pick([], 'あいうえおち')).toEqual(['known', 'none']);
    expect(pick(['一'], 'あいうえおちひとり')).toEqual(['one-new', 'none', 'known']);
  });

  it('leaves out excluded sentences', () => {
    const ids = pickIPlusOne(sentences, new Set(['一']), [], { exclude: new Set(['known']) }).map((x) => x.id);
    expect(ids).not.toContain('known');
  });
});

describe('pickSentences', () => {
  it('needs the kana of a sentence to be known in phase 1', async () => {
    expect(await pickSentences(4, { now: NOW })).toEqual([]);
    for (const ch of 'あいうえお') await introduceItem('kana', ch, NOW);
    expect((await pickSentences(4, { now: NOW })).map((x) => x.id)).toEqual(['s-ichi', 's-kana']);
  });

  it('drops kana-only sentences after phase 1 and follows the kanji learned', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await applyKnownKana(NOW);
    expect((await pickSentences(4, { now: NOW })).map((x) => x.id)).toEqual(['s-ichi']);
    await introduceItem('kanji', '一', NOW);
    expect((await pickSentences(4, { now: NOW })).map((x) => x.id)).toEqual(['s-hito', 's-ichi']);
  });

  it('rests sentences for a week after they are shown', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await introduceItem('kanji', '一', NOW);
    markSentencesShown(['s-hito'], NOW);
    expect((await pickSentences(4, { now: at(2026, 10, 20, 9) })).map((x) => x.id)).toEqual(['s-ichi']);
    expect((await pickSentences(4, { now: at(2026, 10, 21, 9) })).map((x) => x.id)).toEqual(['s-hito', 's-ichi']);
  });

  it('feeds planToday with a phase-sized reading list', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    fixtures.sentences = Array.from({ length: 6 }, (_, i) => ({ id: `s-${i}`, jp: '{一|いち}', en: '' }));
    const plan = await planToday(NOW);
    expect(plan.reading).toEqual(['s-0', 's-1', 's-2']);
    expect(readingCountFor(1)).toBe(2);
    expect(readingCountFor(3)).toBe(4);
  });
});
