import { describe, expect, it } from 'vitest';
import type { MemberProgress } from '../../shared/api.ts';
import type { DayRecord } from '../lib/types.ts';
import { buildStatsPayload, sanitizeProgress, toDayStats, type StatsInputs } from './statsPayload.ts';

const day = (date: string, patch: Partial<DayRecord> = {}): DayRecord => ({
  date,
  studyMs: 0,
  togetherMs: 0,
  reviews: 0,
  correct: 0,
  reviewMs: 0,
  strandMs: 0,
  newItems: 0,
  newSec: { sprint: 0, kanji: 0, core: 0, grammar: 0, staged: 0 },
  minimumDone: false,
  goalMet: false,
  steps: [],
  ...patch,
});

const progress: MemberProgress = {
  unit: 3,
  chapter: 5,
  kanjiCanWrite: 40,
  kanjiCanRead: 55,
  wordsKnown: 310,
  grammarKnown: 21,
  hoursTotal: 31.26,
  daysThisMonth: 12,
  longestStreak: 19,
  readyStories: ['st-l0-01', 'st-l0-02'],
  recentKanji: ['水', '火'],
  recentItems: ['kanji:水', 'core:cw-0101', 'grammar:te-form'],
  settledUnit: 2,
  coreReached: 140,
  grammarReached: 18,
};

const inputs = (patch: Partial<StatsInputs> = {}): StatsInputs => ({
  days: [],
  tokens: new Set(),
  streak: 0,
  knownKanji: [],
  progress,
  shareAccuracy: false,
  ...patch,
});

const opts = { token: false, shareAccuracy: false };

describe('toDayStats', () => {
  it('converts study and together time to whole minutes and maps the v2 day flags', () => {
    expect(toDayStats(day('2026-10-14', {
      studyMs: 12.6 * 60_000, togetherMs: 15 * 60_000, reviews: 40, correct: 35, newItems: 5, minimumDone: true, goalMet: true,
    }), { token: false, shareAccuracy: true })).toEqual({
      date: '2026-10-14',
      studyMinutes: 13,
      reviews: 40,
      correct: 35,
      newItems: 5,
      sessionComplete: true,
      minimumDone: true,
      togetherMinutes: 15,
      restToken: false,
      accuracyShared: true,
    });
  });

  it('sends sessionComplete = goalMet: a minimum day is not a completed plan', () => {
    expect(toDayStats(day('2026-10-14', { minimumDone: true }), opts)).toMatchObject({ sessionComplete: false, minimumDone: true });
    expect(toDayStats(day('2026-10-14', { goalMet: true, minimumDone: true }), opts)).toMatchObject({ sessionComplete: true, minimumDone: true });
  });

  it('keeps accuracy private unless the member shares it', () => {
    const d = day('2026-10-14', { reviews: 20, correct: 17 });
    expect(toDayStats(d, { token: false, shareAccuracy: false })).toMatchObject({ reviews: 20, correct: 0, accuracyShared: false });
    expect(toDayStats(d, { token: false, shareAccuracy: true })).toMatchObject({ reviews: 20, correct: 17, accuracyShared: true });
  });

  it('marks a rest-token day', () => {
    expect(toDayStats(day('2026-10-13'), { token: true, shareAccuracy: false })).toMatchObject({ restToken: true, minimumDone: false });
  });

  it('never reports more right answers than reviews (the server rejects that)', () => {
    const shared = { token: false, shareAccuracy: true };
    expect(toDayStats(day('2026-10-14', { reviews: 3, correct: 10 }), shared)).toMatchObject({ reviews: 3, correct: 3 });
    expect(toDayStats(day('2026-10-14', { reviews: 3, correct: 2 }), shared)).toMatchObject({ reviews: 3, correct: 2 });
  });

  it('caps study time at a day and never sends NaN (the server rejects the whole upload otherwise)', () => {
    // e.g. a session timer that kept counting while the phone slept overnight
    expect(toDayStats(day('2026-10-14', { studyMs: 30 * 60 * 60_000 }), opts).studyMinutes).toBe(24 * 60);
    expect(toDayStats(day('2026-10-14', { studyMs: Number.NaN }), opts).studyMinutes).toBe(0);
    expect(toDayStats(day('2026-10-14', { togetherMs: -1 }), opts).togetherMinutes).toBe(0);
    expect(JSON.parse(JSON.stringify(toDayStats(day('2026-10-14', { reviews: Number.NaN }), opts)))).toMatchObject({ reviews: 0 });
  });
});

describe('buildStatsPayload', () => {
  it('builds the upload body, oldest day first, with rest tokens and without phase', () => {
    const payload = buildStatsPayload(inputs({
      days: [day('2026-10-14', { reviews: 3 }), day('2026-10-12'), day('2026-10-13', { goalMet: true, minimumDone: true })],
      tokens: new Set(['2026-10-12']),
      streak: 4,
      knownKanji: ['水', '火', '木'],
    }));
    expect(payload.days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(payload.days.map((d) => d.restToken)).toEqual([true, false, false]);
    expect(payload).toMatchObject({ streak: 4, kanjiKnown: 3, knownKanji: ['水', '火', '木'] });
    expect(payload).not.toHaveProperty('phase');
  });

  it('passes the progress summary through with its v2 fields', () => {
    expect(buildStatsPayload(inputs()).progress).toEqual({ ...progress, hoursTotal: 31.3 });
  });

  it('dedupes repeated days (last record wins) and repeated kanji', () => {
    const payload = buildStatsPayload(inputs({
      days: [day('2026-10-14', { reviews: 1 }), day('2026-10-14', { reviews: 9 })],
      streak: 1,
      knownKanji: new Set(['一', '二']),
    }));
    expect(payload.days).toHaveLength(1);
    expect(payload.days[0].reviews).toBe(9);

    expect(buildStatsPayload(inputs({ knownKanji: ['一', '一', '二'] }))).toMatchObject({ kanjiKnown: 2, knownKanji: ['一', '二'] });
  });

  it('clamps odd inputs into the ranges the server expects', () => {
    const payload = buildStatsPayload(inputs({ days: [day('2026-10-14', { studyMs: -5 })], streak: -2.5 }));
    expect(payload).toMatchObject({ streak: 0, kanjiKnown: 0 });
    expect(payload.days[0].studyMinutes).toBe(0);
    expect(buildStatsPayload(inputs({ streak: 3.9 }))).toMatchObject({ streak: 3 });
  });
});

describe('sanitizeProgress', () => {
  it('caps the lists the server limits and keeps counts whole and non-negative', () => {
    const many = Array.from({ length: 30 }, (_, i) => `core:cw-${String(i).padStart(4, '0')}`);
    const clean = sanitizeProgress({
      ...progress,
      wordsKnown: -3,
      kanjiCanRead: 12.4,
      unit: 0,
      hoursTotal: Number.NaN,
      readyStories: Array.from({ length: 70 }, (_, i) => `st-${i}`),
      recentItems: [...many, many[0]],
      recentKanji: ['水', '水', ''],
    });
    expect(clean.recentItems).toHaveLength(20);
    expect(clean.readyStories).toHaveLength(60);
    expect(clean.recentKanji).toEqual(['水']);
    expect(clean).toMatchObject({ wordsKnown: 0, kanjiCanRead: 12, unit: 1, hoursTotal: 0 });
  });
});
