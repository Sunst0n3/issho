// Pure conversion from local progress to the POST /api/stats body. Kept apart from
// stats.ts so it can be tested without the SRS engine and IndexedDB.

import type { DayStats, StatsUploadRequest } from '../../shared/api.ts';
import type { DayRecord } from '../lib/types.ts';

export interface StatsInputs {
  /** Local day records (usually the last 7 days), any order. */
  days: DayRecord[];
  /** Current streak in days. */
  streak: number;
  /** Every kanji introduced so far. */
  knownKanji: Iterable<string>;
  phase: number;
}

// The server validates every field (server/src/routes/stats.ts) and rejects the whole
// upload over one bad value, which would stop stats sharing until the bad day ages
// out of the 7-day window. So values are clamped into its ranges here.
const MAX_DAY_MINUTES = 24 * 60;
const MAX_COUNT = 1_000_000;

function clamp(value: number, min: number, max: number, round: (n: number) => number = Math.round): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, round(value))) : min;
}

export function toDayStats(d: DayRecord): DayStats {
  return {
    date: d.date,
    // studyMs is open-ended (e.g. a session timer left running while the phone slept).
    studyMinutes: clamp(d.studyMs / 60_000, 0, MAX_DAY_MINUTES),
    reviews: clamp(d.reviews, 0, MAX_COUNT),
    // The server refuses more right answers than reviews.
    correct: Math.min(clamp(d.correct, 0, MAX_COUNT), clamp(d.reviews, 0, MAX_COUNT)),
    newItems: clamp(d.newItems, 0, MAX_COUNT),
    sessionComplete: Boolean(d.sessionComplete),
  };
}

export function buildStatsPayload(inputs: StatsInputs): StatsUploadRequest {
  const byDate = new Map<string, DayRecord>();
  for (const d of inputs.days) byDate.set(d.date, d);
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(toDayStats);
  const knownKanji = [...new Set(inputs.knownKanji)];
  return {
    days,
    streak: clamp(inputs.streak, 0, MAX_COUNT, Math.floor),
    kanjiKnown: knownKanji.length,
    knownKanji,
    phase: clamp(inputs.phase, 1, 4),
  };
}
