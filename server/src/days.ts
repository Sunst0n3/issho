import type { DayStats } from '../../shared/api.ts';

/** Same rule as the app's `dayKey()`: a study day rolls over at 4 a.m. local time. */
const ROLLOVER_HOURS = 4;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' study day for `date` in the server's local time zone (set TZ in the container). */
export function dayKey(date: Date): string {
  const shifted = new Date(date.getTime() - ROLLOVER_HOURS * 60 * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function isDayKey(value: string): boolean {
  return DAY_KEY.test(value) && addDays(value, 0) === value;
}

/** The `count` days ending at `today`, oldest first. */
export function lastDays(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(today, i - count + 1));
}

export function emptyDay(date: string): DayStats {
  return { date, studyMinutes: 0, reviews: 0, correct: 0, newItems: 0, sessionComplete: false };
}

/** One entry per day of `window`, using `days` where present and zeros elsewhere. */
export function fillDays(window: readonly string[], days: readonly DayStats[]): DayStats[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return window.map((date) => byDate.get(date) ?? emptyDay(date));
}

/**
 * Consecutive days on which every member completed a session. The run may end today or
 * yesterday, so the streak doesn't drop to zero in the morning before anyone has studied.
 */
export function sharedStreak(daysEveryoneCompleted: ReadonlySet<string>, today: string): number {
  let day = daysEveryoneCompleted.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (daysEveryoneCompleted.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}
