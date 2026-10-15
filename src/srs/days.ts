// Study-day bookkeeping: arithmetic on 'YYYY-MM-DD' day keys (see dayKey in
// src/lib/db.ts) and read/update helpers for the per-day DayRecord.

import { db } from '../lib/db.ts';
import type { DayRecord, NewStream, StreamSeconds } from '../lib/types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export const NEW_STREAMS: readonly NewStream[] = ['sprint', 'kanji', 'staged', 'core', 'grammar'];

// Day keys are calendar dates, so they are handled as UTC midnights: no
// time zone or daylight-saving shift can move them.
function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return utcToKey(keyToUtc(key) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((keyToUtc(to) - keyToUtc(from)) / DAY_MS);
}

/** ISO weekday of a day key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(key: string): number {
  const weekday = new Date(keyToUtc(key)).getUTCDay(); // 0 = Sunday
  return weekday === 0 ? 7 : weekday;
}

/**
 * Where a date-indexed query for "today" can start: a study day lasts at most
 * 25 hours (on a daylight-saving change), so this reaches back past its start.
 * Keep the rows whose dayKey is today's.
 */
export function studyDayLookback(now: Date): Date {
  return new Date(now.getTime() - 26 * 60 * 60 * 1000);
}

/** Monday of the ISO week (Mon–Sun) containing `key`. */
export function weekStart(key: string): string {
  return addDays(key, 1 - isoWeekday(key));
}

/** The local 4 a.m. that starts the study day `key` (see dayKey). */
export function dayStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 4, 0, 0, 0);
}

export function emptyStreamSeconds(): StreamSeconds {
  return { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 };
}

export function emptyDay(date: string): DayRecord {
  return {
    date,
    studyMs: 0,
    togetherMs: 0,
    reviews: 0,
    correct: 0,
    reviewMs: 0,
    strandMs: 0,
    newItems: 0,
    newSec: emptyStreamSeconds(),
    minimumDone: false,
    goalMet: false,
    steps: [],
  };
}

/** A stored row with every v2 field filled in (rows written by older code may lack some). */
export function normalizeDay(row: DayRecord | undefined, date: string): DayRecord {
  if (!row) return emptyDay(date);
  const empty = emptyDay(date);
  return {
    ...empty,
    ...row,
    newSec: { ...empty.newSec, ...row.newSec },
    steps: [...(row.steps ?? [])],
  };
}

export async function getDay(date: string): Promise<DayRecord> {
  return normalizeDay(await db.days.get(date), date);
}

/** Read-modify-write of one DayRecord; joins the caller's transaction when there is one. */
export function updateDay(date: string, change: (day: DayRecord) => void): Promise<DayRecord> {
  return db.transaction('rw', db.days, async () => {
    const day = await getDay(date);
    change(day);
    await db.days.put(day);
    return day;
  });
}

/** A duration safe to add up: whole, non-negative ms, and 0 for NaN or Infinity. */
export function countableMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

/** Σ of a day's priced new-learning seconds over all five streams. */
export function totalNewSec(newSec: Partial<StreamSeconds> | undefined): number {
  let sum = 0;
  for (const stream of NEW_STREAMS) sum += newSec?.[stream] ?? 0;
  return sum;
}

/**
 * A day the learner actually studied: it counts toward the course day. Something was learned: a graded answer, a new
 * item, read/output/fluency time, a together session, or the minimum day. Bare session time (studyMs) is not enough:
 * opening a sitting with nothing in it and leaving must not move the phase gates (the streak never counted it either).
 */
export function isStudyDay(day: Pick<DayRecord, 'reviews' | 'newItems' | 'strandMs' | 'togetherMs' | 'minimumDone'>): boolean {
  return day.reviews > 0 || day.newItems > 0 || (day.strandMs ?? 0) > 0 || (day.togetherMs ?? 0) > 0 || day.minimumDone;
}
