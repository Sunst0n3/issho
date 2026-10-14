import { describe, expect, it } from 'vitest';
import type { DayRecord } from '../lib/types.ts';
import { buildStatsPayload, toDayStats } from './statsPayload.ts';

const day = (date: string, patch: Partial<DayRecord> = {}): DayRecord => ({
  date, studyMs: 0, reviews: 0, correct: 0, newItems: 0, sessionComplete: false, ...patch,
});

describe('toDayStats', () => {
  it('converts study time to whole minutes and keeps the counters', () => {
    expect(toDayStats(day('2026-10-14', { studyMs: 12.6 * 60_000, reviews: 40, correct: 35, newItems: 5, sessionComplete: true })))
      .toEqual({ date: '2026-10-14', studyMinutes: 13, reviews: 40, correct: 35, newItems: 5, sessionComplete: true });
  });
});

describe('buildStatsPayload', () => {
  it('builds the upload body, oldest day first', () => {
    const payload = buildStatsPayload({
      days: [day('2026-10-14', { reviews: 3 }), day('2026-10-12'), day('2026-10-13', { sessionComplete: true })],
      streak: 4,
      knownKanji: ['水', '火', '木'],
      phase: 2,
    });
    expect(payload.days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(payload).toMatchObject({ streak: 4, kanjiKnown: 3, knownKanji: ['水', '火', '木'], phase: 2 });
  });

  it('dedupes repeated days (last record wins) and repeated kanji', () => {
    const payload = buildStatsPayload({
      days: [day('2026-10-14', { reviews: 1 }), day('2026-10-14', { reviews: 9 })],
      streak: 1,
      knownKanji: new Set(['一', '二']),
      phase: 2,
    });
    expect(payload.days).toHaveLength(1);
    expect(payload.days[0].reviews).toBe(9);

    expect(buildStatsPayload({ days: [], streak: 0, knownKanji: ['一', '一', '二'], phase: 1 }))
      .toMatchObject({ kanjiKnown: 2, knownKanji: ['一', '二'] });
  });

  it('clamps odd inputs into the ranges the server expects', () => {
    const payload = buildStatsPayload({ days: [day('2026-10-14', { studyMs: -5 })], streak: -2.5, knownKanji: [], phase: 9 });
    expect(payload).toMatchObject({ streak: 0, phase: 4, kanjiKnown: 0 });
    expect(payload.days[0].studyMinutes).toBe(0);
    expect(buildStatsPayload({ days: [], streak: 3.9, knownKanji: [], phase: 0 })).toMatchObject({ streak: 3, phase: 1 });
  });

  it('caps study time at a day and never sends NaN (the server rejects the whole upload otherwise)', () => {
    // e.g. a session timer that kept counting while the phone slept overnight
    expect(toDayStats(day('2026-10-14', { studyMs: 30 * 60 * 60_000 })).studyMinutes).toBe(24 * 60);
    expect(toDayStats(day('2026-10-14', { studyMs: Number.NaN })).studyMinutes).toBe(0);
    expect(JSON.parse(JSON.stringify(toDayStats(day('2026-10-14', { reviews: Number.NaN }))))).toMatchObject({ reviews: 0 });
  });
});
