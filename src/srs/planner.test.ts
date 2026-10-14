import { Rating, State, type Grade } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../lib/db.ts';
import type { CardRecord, SentenceEntry } from '../lib/types.ts';
import { applyKnownKana, introducePlanItem } from './course.ts';
import { DAY_MS } from './days.ts';
import { introduceItem, markKnownMany } from './items.ts';
import {
  backlogThreshold,
  capReviews,
  dueCount,
  estimateMinutes,
  markSentencesShown,
  orderReviews,
  pickIPlusOne,
  pickSentences,
  planToday,
  readingCountFor,
  resetSentencesShown,
} from './planner.ts';
import { learnedToday } from './progress.ts';
import { gradeCard, newCardRecord } from './scheduler.ts';
import { at, BASIC_HIRAGANA, fixtures, inTimeZone, resetDb } from './test-fixtures.ts';

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

describe('capReviews', () => {
  it('caps Review-state cards only, keeping every card in its first steps', () => {
    const cards = [
      dueCard(1, 1),
      dueCard(2, 5),
      dueCard(3, 0.01, { state: State.Learning }),
      dueCard(4, 3),
      dueCard(5, 0.5, { state: State.Relearning }),
      dueCard(6, 0, { state: State.New }),
    ];
    const ids = (room: number) => capReviews(cards, room).map((c) => c.itemId);
    expect(ids(2)).toEqual(['kanji:k5', 'kanji:k3', 'kanji:k6', 'kanji:k2', 'kanji:k4']);
    expect(ids(0)).toEqual(['kanji:k5', 'kanji:k3', 'kanji:k6']);
    expect(ids(-4)).toEqual(ids(0));
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

  it('adds every card in its first steps on top of the cap', async () => {
    await updateSettings({ maxReviewsPerDay: 5 });
    await addDue(8);
    await db.cards.bulkAdd([
      dueCard(101, 0.01, { state: State.Learning }),
      dueCard(102, 0.02, { state: State.Relearning }),
      newCardRecord('kana:あ', 'kana', 'read', NOW),
    ]);
    const plan = await planToday(NOW);
    expect(plan.reviews.slice(0, 3)).toEqual(['kanji:k102|meaning', 'kanji:k101|meaning', 'kana:あ|read']);
    expect(plan.reviews).toHaveLength(8);
    expect(plan.backlog).toBe(11);
  });

  it('only counts answers to Review-state cards toward the cap', async () => {
    await updateSettings({ maxReviewsPerDay: 2 });
    await addDue(4); // k3 is the most overdue, then k2
    await db.cards.add(newCardRecord('kana:あ', 'kana', 'read', NOW));
    const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
    const grade = (id: string, rating: Grade, m: number) =>
      gradeCard(id, rating, { durationMs: 1000, mode: 'choice', now: minutes(m) });

    // Learning steps, however many, leave the cap alone.
    for (const m of [0, 2, 4]) await grade('kana:あ|read', Rating.Again, m);
    // A lapse uses one review and comes back for relearning the same day.
    await grade('kanji:k3|meaning', Rating.Again, 5);
    expect((await db.days.get('2026-10-14'))!.reviews).toBe(4);

    const plan = await planToday(minutes(60));
    expect(plan.reviews.slice(0, 2).sort()).toEqual(['kana:あ|read', 'kanji:k3|meaning']);
    expect(plan.reviews.slice(2)).toEqual(['kanji:k2|meaning']);
  });

  /** Grades the first planned review at `time`. */
  async function reviewOne(time: Date): Promise<void> {
    const [id] = (await planToday(time)).reviews;
    await gradeCard(id, Rating.Good, { durationMs: 1000, mode: 'choice', now: time });
  }

  it('counts the cap per study day, rolling over at 4 a.m.', async () => {
    await updateSettings({ maxReviewsPerDay: 2 });
    await addDue(6);
    await reviewOne(at(2026, 10, 14, 3, 59)); // the 13th's study day
    await reviewOne(at(2026, 10, 14, 4, 0));
    expect((await planToday(at(2026, 10, 14, 4, 1))).reviews).toHaveLength(1);
    await reviewOne(at(2026, 10, 15, 3, 59));
    expect((await planToday(at(2026, 10, 15, 3, 59))).reviews).toEqual([]);
    expect((await planToday(at(2026, 10, 15, 4, 0))).reviews).toHaveLength(2);
  });

  it('counts the whole 25-hour study day when the clocks go back', () =>
    inTimeZone('America/New_York', async () => {
      // The study day of Sat 2026-10-31 runs from 04:00 EDT to Sun 04:00 EST.
      await updateSettings({ maxReviewsPerDay: 2 });
      await addDue(6);
      await reviewOne(new Date(2026, 9, 31, 4, 0));
      await reviewOne(new Date(2026, 10, 1, 3, 59)); // 24 h 59 min later
      expect((await planToday(new Date(2026, 10, 1, 3, 59))).reviews).toEqual([]);
      expect((await planToday(new Date(2026, 10, 1, 4, 0))).reviews).toHaveLength(2);
    }));

  it("leaves the previous day's answers out when the clocks go forward", () =>
    inTimeZone('America/New_York', async () => {
      // The study day of Sat 2026-03-07 is 23 hours long.
      await updateSettings({ maxReviewsPerDay: 2 });
      await db.cards.bulkAdd(Array.from({ length: 6 }, (_, i) => dueCard(i, 250 + i)));
      await reviewOne(new Date(2026, 2, 7, 3, 59)); // Friday's study day
      await reviewOne(new Date(2026, 2, 7, 4, 0));
      expect((await planToday(new Date(2026, 2, 8, 3, 59))).reviews).toHaveLength(1);
    }));
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
    expect(plan.reviews).toHaveLength(121);
    expect(plan.reviews[0]).toBe('kanji:k999|meaning');
    const dueOf = async (id: string) => (await db.cards.get(id))!.due.getTime();
    expect(await dueOf(plan.reviews[1])).toBeLessThanOrEqual(await dueOf(plan.reviews[120]));
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked?.reason).toMatch(/301 reviews/);
  });

  it('shows 300 cards in their first steps uncapped, and pauses new items for them', async () => {
    await db.cards.bulkAdd(
      Array.from({ length: 300 }, (_, i) => dueCard(i, (i % 20) + 1, { state: i % 3 ? State.Learning : State.New, reps: i % 3 })),
    );
    let plan = await planToday(NOW);
    expect(plan.reviews).toHaveLength(300);
    expect(plan.backlog).toBe(300);
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked?.reason).toMatch(/300 reviews/);

    await db.cards.bulkAdd(Array.from({ length: 200 }, (_, i) => dueCard(1000 + i, 1)));
    plan = await planToday(NOW);
    expect(plan.reviews).toHaveLength(300 + 120);
    const cards = await db.cards.bulkGet(plan.reviews);
    expect(cards.slice(0, 300).every((c) => c!.state !== State.Review)).toBe(true);
    expect(plan.backlog).toBe(500);
  });

  it('counts cards in their first steps toward the backlog pause', async () => {
    await updateSettings({ maxReviewsPerDay: 20 });
    await addDue(30);
    await db.cards.bulkAdd(Array.from({ length: 10 }, (_, i) => dueCard(200 + i, 0.01, { state: State.Relearning })));
    let plan = await planToday(NOW);
    expect(plan.backlog).toBe(40);
    expect(plan.reviews).toHaveLength(30);
    expect(plan.newBlocked).toBeUndefined();

    await db.cards.add(dueCard(300, 0.01, { state: State.Learning }));
    plan = await planToday(NOW);
    expect(plan.reviews).toHaveLength(31);
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked?.reason).toMatch(/41 reviews/);
  });

  it("doesn't report a pause once the day's new items are done", async () => {
    await updateSettings({ newPerDay: 2 });
    await addDue(151);
    expect((await planToday(NOW)).newBlocked).toBeDefined();
    await introduceItem('kana', 'あ', NOW);
    await introduceItem('kana', 'い', NOW);
    const plan = await planToday(NOW);
    expect(plan.newItems).toEqual([]);
    expect(plan.newBlocked).toBeUndefined();
  });

  it('tops the day up to newPerDay in a later session without pushing out words or grammar', async () => {
    await markKnownMany(BASIC_HIRAGANA.map((key) => ({ kind: 'kana' as const, key })), NOW);
    const morning = await planToday(NOW);
    expect(morning.newItems.map((p) => p.key)).toEqual(['が', 'ご', 'きゃ', 'sw-ai', 'g-wa']);
    for (const item of morning.newItems.slice(0, 3)) await introducePlanItem(item, NOW);

    const evening = await planToday(at(2026, 10, 14, 20));
    expect(evening.newItems.map((p) => p.key)).toEqual(['sw-ai', 'g-wa']);
    for (const item of evening.newItems) await introducePlanItem(item, at(2026, 10, 14, 20));

    expect((await planToday(at(2026, 10, 14, 22))).newItems).toEqual([]);
  });

  it('starts on the curriculum when all kana are known from settings, and brings them back as reviews', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true, maxReviewsPerDay: 20 });
    const fromSettings = (await planToday(NOW)).newItems.map((p) => p.key);
    expect(fromSettings).toEqual(['亻', '一', '人', 'sw-ai', 'g-wa']);

    await applyKnownKana(NOW);
    const plan = await planToday(NOW);
    expect(plan.reviews).toEqual([]);
    expect(plan.newItems.map((p) => p.key)).toEqual(fromSettings);
    expect(await learnedToday(NOW)).toEqual([]);

    const kanaCards = await db.cards.where('kind').equals('kana').count();
    const later = await planToday(new Date(NOW.getTime() + 15 * DAY_MS));
    expect(later.backlog).toBe(kanaCards);
    expect(later.reviews).toHaveLength(20);
    expect(later.newBlocked?.reason).toMatch(new RegExp(`${kanaCards} reviews`));
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

  it('keeps the history in memory while storage refuses writes', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await introduceItem('kanji', '一', NOW);
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      markSentencesShown(['s-hito'], NOW);
      expect((await pickSentences(4, { now: NOW })).map((x) => x.id)).toEqual(['s-ichi']);
    } finally {
      setItem.mockRestore();
      resetSentencesShown();
    }
  });

  it('forgets shown sentences when the history is reset', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await introduceItem('kanji', '一', NOW);
    markSentencesShown(['s-hito'], NOW);
    resetSentencesShown();
    expect((await pickSentences(4, { now: NOW })).map((x) => x.id)).toEqual(['s-hito', 's-ichi']);
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
