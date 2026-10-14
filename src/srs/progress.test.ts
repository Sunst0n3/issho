import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import type { CardRecord, ReviewLogRecord } from '../lib/types.ts';
import { DAY_MS } from './days.ts';
import { introduceItem } from './items.ts';
import {
  addStudyTime,
  completeSession,
  hardestKanji,
  knownKanji,
  rankHardKanji,
  streak,
  streakFromDays,
  summary,
  weekStats,
} from './progress.ts';
import { newCardRecord } from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

// Week of Mon 2026-10-12 … Sun 2026-10-18.
const statuses = (info: ReturnType<typeof streakFromDays>) => info.week.map((d) => d.status);

describe('streakFromDays', () => {
  it('is empty for a new learner', () => {
    const info = streakFromDays([], '2026-10-14');
    expect(info).toMatchObject({ current: 0, best: 0, todayDone: false });
    expect(info.week.map((d) => d.date)).toEqual([
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
    ]);
    expect(statuses(info)).toEqual(['missed', 'missed', 'today', 'future', 'future', 'future', 'future']);
  });

  it("counts consecutive days and doesn't break on a today that isn't over", () => {
    const info = streakFromDays(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'], '2026-10-14');
    expect(info).toMatchObject({ current: 4, best: 4, todayDone: false });
    expect(statuses(info).slice(0, 3)).toEqual(['done', 'done', 'today']);

    const done = streakFromDays(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14');
    expect(done).toMatchObject({ current: 3, todayDone: true });
    expect(statuses(done).slice(0, 3)).toEqual(['done', 'done', 'done']);
  });

  it('covers one missed day per ISO week with a rest day', () => {
    const info = streakFromDays(['2026-10-11', '2026-10-12', '2026-10-14'], '2026-10-14');
    expect(info.current).toBe(3);
    expect(statuses(info).slice(0, 3)).toEqual(['done', 'rest', 'done']);
  });

  it('breaks on a second missed day in the same week', () => {
    // Mon done, Tue missed (the week's rest day), Wed done, Thu missed: the streak ends on Thu.
    const info = streakFromDays(['2026-10-12', '2026-10-14', '2026-10-16'], '2026-10-16');
    expect(info).toMatchObject({ current: 1, best: 2 });
    expect(statuses(info).slice(0, 5)).toEqual(['done', 'missed', 'done', 'missed', 'done']);

    expect(streakFromDays(['2026-10-12'], '2026-10-15').current).toBe(0);
  });

  it('keeps the rest day where it was taken, so a later miss that week breaks the streak', () => {
    const done = ['2026-10-12', '2026-10-14', '2026-10-15'];
    // Thursday: Tue is the rest day.
    const thursday = streakFromDays(done, '2026-10-15');
    expect(thursday.current).toBe(3);
    expect(statuses(thursday).slice(0, 4)).toEqual(['done', 'rest', 'done', 'done']);
    // Friday isn't over yet, so it doesn't break anything.
    expect(streakFromDays(done, '2026-10-16').current).toBe(3);
    // Saturday: Friday was the week's second miss.
    const saturday = streakFromDays(done, '2026-10-17');
    expect(saturday).toMatchObject({ current: 0, best: 3 });
    expect(statuses(saturday).slice(0, 6)).toEqual(['done', 'missed', 'done', 'done', 'missed', 'today']);
    expect(streakFromDays([...done, '2026-10-17'], '2026-10-17').current).toBe(1);
  });

  it('allows one rest day per week, even across a broken streak', () => {
    // Mon done, Tue missed (rest), Wed missed (streak over), Thu done, Fri missed, Sat done.
    const info = streakFromDays(['2026-10-12', '2026-10-15', '2026-10-17'], '2026-10-17');
    expect(info.current).toBe(1);
    expect(statuses(info).slice(0, 6)).toEqual(['done', 'missed', 'missed', 'done', 'missed', 'done']);
  });

  it('does not spend a rest day while there is no streak to keep', () => {
    // Fri 10-09 done; Sat rest, Sun missed: over. Mon 10-12 missed with no streak, Tue done, Wed rest, Thu done.
    const info = streakFromDays(['2026-10-09', '2026-10-13', '2026-10-15'], '2026-10-15');
    expect(info.current).toBe(2);
    expect(statuses(info).slice(0, 4)).toEqual(['missed', 'done', 'rest', 'done']);
  });

  it('allows rest days in two different weeks, even back to back', () => {
    // Sat 10-10 done, Sun 10-11 missed (week 1), Mon 10-12 missed (week 2), Tue 10-13 done.
    const info = streakFromDays(['2026-10-09', '2026-10-10', '2026-10-13'], '2026-10-13');
    expect(info.current).toBe(3);
    expect(statuses(info)[0]).toBe('rest');
  });

  it("doesn't treat days before the streak began as rest days", () => {
    const info = streakFromDays(['2026-10-14'], '2026-10-14');
    expect(info.current).toBe(1);
    expect(statuses(info).slice(0, 3)).toEqual(['missed', 'missed', 'done']);
  });

  it('remembers the best streak', () => {
    const early = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    const info = streakFromDays([...early, '2026-10-13', '2026-10-14'], '2026-10-14');
    expect(info).toMatchObject({ current: 2, best: 5 });
  });

  it('counts a rest-bridged streak toward the best', () => {
    // Sep 7 (Mon) – Sep 13 (Sun): one missed Wednesday keeps the 6 days together.
    const run = ['2026-09-07', '2026-09-08', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
    expect(streakFromDays(run, '2026-10-14')).toMatchObject({ current: 0, best: 6 });
  });

  it('ignores days after today', () => {
    expect(streakFromDays(['2026-10-15'], '2026-10-14')).toMatchObject({ current: 0, best: 0 });
  });
});

describe('completeSession and streak', () => {
  it('rolls the study day over at 4 a.m.', async () => {
    await completeSession(at(2026, 10, 14, 21));
    const info = await completeSession(at(2026, 10, 16, 1, 30)); // still Thursday 10-15's study day
    expect(await db.days.get('2026-10-15')).toMatchObject({ sessionComplete: true });
    expect(await db.days.get('2026-10-16')).toBeUndefined();
    expect(info).toMatchObject({ current: 2, todayDone: true });

    expect(await streak(at(2026, 10, 16, 3, 59))).toMatchObject({ current: 2, todayDone: true });
    expect(await streak(at(2026, 10, 16, 4, 0))).toMatchObject({ current: 2, todayDone: false });
  });

  it('records the rest day the streak relies on', async () => {
    await completeSession(at(2026, 10, 12, 9));
    await completeSession(at(2026, 10, 14, 9));
    expect(await db.days.get('2026-10-13')).toMatchObject({ restDay: true, sessionComplete: false, reviews: 0 });
    expect((await streak(at(2026, 10, 14, 22))).current).toBe(2);
  });

  it('never records two rest days in one week', async () => {
    for (const d of [12, 14, 16]) await completeSession(at(2026, 10, d, 9));
    const rests = (await db.days.toArray()).filter((d) => d.restDay).map((d) => d.date);
    expect(rests).toEqual(['2026-10-13']);
    expect((await streak(at(2026, 10, 16, 22))).current).toBe(1);
  });

  it('counts calendar days across a daylight-saving change', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York'; // clocks go back on Sun 2026-11-01
    try {
      for (let d = 29; d <= 31; d++) await completeSession(new Date(2026, 9, d, 21));
      for (let d = 1; d <= 3; d++) await completeSession(new Date(2026, 10, d, 21));
      expect(await streak(new Date(2026, 10, 3, 22))).toMatchObject({ current: 6, todayDone: true });
      expect((await db.days.toArray()).map((d) => d.date)).toEqual([
        '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
      ]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('addStudyTime', () => {
  it("adds to today's study time", async () => {
    await addStudyTime(90_000, at(2026, 10, 14, 9));
    await addStudyTime(30_400, at(2026, 10, 14, 10));
    await addStudyTime(-5, at(2026, 10, 14, 10));
    await addStudyTime(Number.NaN, at(2026, 10, 14, 10));
    await addStudyTime(Infinity, at(2026, 10, 14, 10));
    expect(await db.days.get('2026-10-14')).toMatchObject({ studyMs: 120_400, reviews: 0, sessionComplete: false });
  });
});

function kanjiCard(char: string, type: CardRecord['type'], patch: Partial<CardRecord>): CardRecord {
  return { ...newCardRecord(`kanji:${char}`, 'kanji', type, at(2026, 10, 1)), state: State.Review, reps: 3, ...patch };
}

describe('hardestKanji', () => {
  it('ranks reviewed kanji by lapses, then by lowest stability', async () => {
    await db.cards.bulkAdd([
      kanjiCard('水', 'meaning', { lapses: 1, stability: 20 }),
      kanjiCard('水', 'write', { lapses: 2, stability: 4 }),
      kanjiCard('火', 'meaning', { lapses: 3, stability: 30 }),
      kanjiCard('木', 'meaning', { lapses: 0, stability: 2 }),
      kanjiCard('金', 'meaning', { lapses: 0, stability: 9 }),
      kanjiCard('土', 'meaning', { lapses: 5, stability: 1, suspended: true }),
      { ...newCardRecord('kanji:日', 'kanji', 'meaning', at(2026, 10, 1)) }, // never reviewed
      { ...newCardRecord('kana:あ', 'kana', 'read', at(2026, 10, 1)), lapses: 9, reps: 9 },
    ]);
    expect(await hardestKanji(10)).toEqual([
      { char: '水', lapses: 3, stability: 4 },
      { char: '火', lapses: 3, stability: 30 },
      { char: '木', lapses: 0, stability: 2 },
      { char: '金', lapses: 0, stability: 9 },
    ]);
    expect((await hardestKanji(2)).map((k) => k.char)).toEqual(['水', '火']);
  });

  it('returns nothing without reviewed kanji', () => {
    expect(rankHardKanji([], 5)).toEqual([]);
  });
});

describe('summary', () => {
  const NOW = at(2026, 10, 14, 9);
  const log = (grade: ReviewLogRecord['grade'], prevState: State, daysAgo: number): ReviewLogRecord => ({
    cardId: 'kanji:水|meaning',
    itemId: 'kanji:水',
    grade,
    prevState,
    reviewedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    durationMs: 1000,
    mode: 'choice',
  });

  it('counts known items and true retention over 30 days', async () => {
    await introduceItem('kana', 'あ', NOW);
    await introduceItem('kana', 'い', NOW);
    await introduceItem('kanji', '水', NOW);
    await introduceItem('word', '1001', NOW);
    await introduceItem('vocab', 'sw-hai', NOW);
    await db.reviewLogs.bulkAdd([
      log(Rating.Good, State.Review, 1),
      log(Rating.Hard, State.Review, 2),
      log(Rating.Easy, State.Review, 3),
      log(Rating.Again, State.Review, 29),
      log(Rating.Again, State.Review, 40), // too old
      log(Rating.Again, State.Learning, 1), // not a mature review
    ]);
    expect(await summary(NOW)).toEqual({
      kanaKnown: 2,
      kanjiKnown: 1,
      wordsKnown: 2,
      reviewsTotal: 6,
      retention30d: 0.75,
    });
  });

  it('has no retention figure before any mature review', async () => {
    expect((await summary()).retention30d).toBeNull();
  });
});

describe('weekStats', () => {
  it('returns the last 7 days oldest first, with zeros for days without study', async () => {
    await addStudyTime(60_000, at(2026, 10, 14, 9));
    await addStudyTime(30_000, at(2026, 10, 9, 9));
    await addStudyTime(99_000, at(2026, 10, 7, 9)); // 8 days back: outside the window
    const week = await weekStats(at(2026, 10, 15, 2)); // before 4 a.m.: still the 14th
    expect(week.map((d) => d.date)).toEqual([
      '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14',
    ]);
    expect(week.map((d) => d.studyMs)).toEqual([0, 30_000, 0, 0, 0, 0, 60_000]);
    expect(week[2]).toEqual({ date: '2026-10-10', studyMs: 0, reviews: 0, correct: 0, newItems: 0, sessionComplete: false });
  });
});

describe('knownKanji', () => {
  it('lists introduced kanji, oldest first', async () => {
    await introduceItem('kanji', '人', at(2026, 10, 14, 9));
    await introduceItem('kanji', '一', at(2026, 10, 13, 9));
    await introduceItem('radical', '亻', at(2026, 10, 12, 9));
    expect(await knownKanji()).toEqual(['一', '人']);
  });
});
