// Study-day bookkeeping: arithmetic on 'YYYY-MM-DD' day keys (see dayKey in
// src/lib/db.ts) and read/update helpers for the per-day DayRecord.

import { db } from '../lib/db.ts';
import type { DayRecord } from '../lib/types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

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
  const weekday = new Date(keyToUtc(key)).getUTCDay(); // 0 = Sunday
  return addDays(key, -((weekday + 6) % 7));
}

export function emptyDay(date: string): DayRecord {
  return { date, studyMs: 0, reviews: 0, correct: 0, newItems: 0, sessionComplete: false };
}

export async function getDay(date: string): Promise<DayRecord> {
  return (await db.days.get(date)) ?? emptyDay(date);
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

/** A day the learner actually studied (rest-day markers alone don't count). */
export function isStudyDay(day: DayRecord): boolean {
  return day.reviews > 0 || day.newItems > 0 || day.studyMs > 0 || day.sessionComplete;
}
