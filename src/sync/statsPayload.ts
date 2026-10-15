// Pure conversion from local progress to the POST /api/stats body. Kept apart from
// stats.ts so it can be tested without the SRS engine and IndexedDB.

import type { DayStats, MemberProgress, StatsUploadRequest } from '../../shared/api.ts';
import type { DayRecord } from '../lib/types.ts';

export interface StatsInputs {
  /** Local day records (usually the last 14 days, zeros included), any order. */
  days: DayRecord[];
  /** Days covered by a rest token. */
  tokens: ReadonlySet<string>;
  /** StreakV2.current: minimum days in the current run (0 when broken). */
  streak: number;
  /** Every kanji introduced so far. */
  knownKanji: Iterable<string>;
  /** The engine's summary (memberProgress()). */
  progress: MemberProgress;
  /** Settings.shareAccuracy: otherwise `correct` goes out as 0 (accuracy is private by default). */
  shareAccuracy: boolean;
}

// The server validates every field (server/src/routes/stats.ts) and rejects the whole
// upload over one bad value, which would stop stats sharing until the bad day ages
// out of the window. So values are clamped into its ranges here.
const MAX_DAY_MINUTES = 24 * 60;
const MAX_COUNT = 1_000_000;
const MAX_READY_STORIES = 60;
const MAX_RECENT = 20;

function clamp(value: number, min: number, max: number, round: (n: number) => number = Math.round): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, round(value))) : min;
}

const count = (n: number) => clamp(n, 0, MAX_COUNT);

export function toDayStats(d: DayRecord, opts: { token: boolean; shareAccuracy: boolean }): DayStats {
  const reviews = count(d.reviews);
  return {
    date: d.date,
    // studyMs is open-ended (e.g. a session timer left running while the phone slept).
    studyMinutes: clamp(d.studyMs / 60_000, 0, MAX_DAY_MINUTES),
    reviews,
    // Private unless shared; the server refuses more right answers than reviews.
    correct: opts.shareAccuracy ? Math.min(count(d.correct), reviews) : 0,
    newItems: count(d.newItems),
    sessionComplete: Boolean(d.goalMet),
    minimumDone: Boolean(d.minimumDone || d.goalMet),
    togetherMinutes: clamp((d.togetherMs ?? 0) / 60_000, 0, MAX_DAY_MINUTES),
    restToken: opts.token,
    accuracyShared: opts.shareAccuracy,
  };
}

/** Distinct non-empty strings, first `max` kept. */
function ids(list: readonly string[] | undefined, max: number): string[] {
  return [...new Set((list ?? []).filter((s) => typeof s === 'string' && s.length > 0))].slice(0, max);
}

/** The engine's summary, kept inside the server's ranges (whole non-negative counts, capped lists). */
export function sanitizeProgress(p: MemberProgress): MemberProgress {
  return {
    unit: clamp(p.unit, 1, 1000),
    chapter: clamp(p.chapter, 0, 1000),
    kanjiCanWrite: count(p.kanjiCanWrite),
    kanjiCanRead: count(p.kanjiCanRead),
    wordsKnown: count(p.wordsKnown),
    grammarKnown: count(p.grammarKnown),
    hoursTotal: clamp(p.hoursTotal, 0, MAX_COUNT, (n) => Math.round(n * 10) / 10),
    daysThisMonth: clamp(p.daysThisMonth, 0, 31),
    longestStreak: count(p.longestStreak),
    readyStories: ids(p.readyStories, MAX_READY_STORIES),
    recentKanji: ids(p.recentKanji, MAX_RECENT),
    recentItems: ids(p.recentItems, MAX_RECENT),
    settledUnit: clamp(p.settledUnit, 0, 1000),
    coreReached: count(p.coreReached),
    grammarReached: count(p.grammarReached),
  };
}

export function buildStatsPayload(inputs: StatsInputs): StatsUploadRequest {
  const byDate = new Map<string, DayRecord>();
  for (const d of inputs.days) byDate.set(d.date, d);
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => toDayStats(d, { token: inputs.tokens.has(d.date), shareAccuracy: inputs.shareAccuracy }));
  const knownKanji = [...new Set(inputs.knownKanji)];
  // No `phase`: v2 has none (the server stores 1 for v2 phones).
  return {
    days,
    streak: clamp(inputs.streak, 0, MAX_COUNT, Math.floor),
    kanjiKnown: knownKanji.length,
    knownKanji,
    progress: sanitizeProgress(inputs.progress),
  };
}
