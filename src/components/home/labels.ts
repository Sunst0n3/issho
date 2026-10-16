// Wording shared by the home screens: daily minutes, dates, greetings, counts.
import type { DailyMinutes, TogetherSlot } from '../../lib/types.ts';

/** Session size guidance; annual introductions vary with reviews, accuracy and days studied. */
export const MINUTES_NOTES: Record<DailyMinutes, string> = {
  20: 'A lighter daily session, with room to build a habit',
  25: 'A steady daily session for reviews and new material',
  30: 'More daily time for reviews, reading and new material',
  40: 'A longer daily session with more room for practice',
};

export const MINUTES_TITLES: Record<DailyMinutes, string> = {
  20: 'Light',
  25: 'Steady',
  30: 'Keen',
  40: 'Intensive',
};

export const DEFAULT_MINUTES: DailyMinutes = 25;

/** Indexed by Date.getDay() (0 = Sunday). */
export const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_JA = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

/** ISO weekday (1 = Monday … 7 = Sunday) → English name. */
export function isoWeekdayName(weekday: TogetherSlot['weekday']): string {
  return WEEKDAYS_EN[weekday % 7];
}

/** 'YYYY-MM-DD' → local Date at noon (safe from DST edges). */
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Local date → 'YYYY-MM-DD' (calendar date, no 4 a.m. rollover). */
export function keyOfDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Calendar days after `key` ('YYYY-MM-DD'); negative goes back. */
export function shiftDay(key: string, days: number): string {
  const d = dateOfKey(key);
  d.setDate(d.getDate() + days);
  return keyOfDate(d);
}

/** Monday of the ISO week that holds `key`. */
export function mondayOf(key: string): string {
  const day = dateOfKey(key).getDay();
  return shiftDay(key, -((day + 6) % 7));
}

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** 'Monday 20 Oct' */
export function dayLabel(key: string): string {
  return SHORT_DATE.format(dateOfKey(key)).replace(',', '');
}

/** '20 Oct' */
export function dayMonth(key: string): string {
  return DAY_MONTH.format(dateOfKey(key));
}

/** '20 October 2026' */
export function longDate(key: string): string {
  return LONG_DATE.format(dateOfKey(key));
}

/** 'Tuesday' for a day key. */
export function weekdayOf(key: string): string {
  return WEEKDAYS_EN[dateOfKey(key).getDay()];
}

/** 'Thursday 4 a.m.', 'Friday 7:30 p.m.' */
export function deadlineText(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const hour = h % 12 === 0 ? 12 : h % 12;
  const time = m ? `${hour}:${String(m).padStart(2, '0')}` : String(hour);
  return `${WEEKDAYS_EN[d.getDay()]} ${time} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

export function greeting(now: Date): string {
  const h = now.getHours();
  if (h >= 4 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function agoText(then: number, now: number = Date.now()): string {
  const min = Math.max(0, Math.round((now - then) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return plural(Math.round(h / 24), 'day') + ' ago';
}

/** "1-day streak", "12-day streak" */
export function streakText(days: number): string {
  return `${days.toLocaleString()}-day streak`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** 0.834 → '83 %' (with a no-break space, so the sign never wraps alone). */
export function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/** 'HH:MM' that a time input accepts, or null. */
export function cleanTime(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
