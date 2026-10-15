import type { CoupleQuest, DayStats, TogetherSessionId } from '../../shared/api.ts';

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

/** ISO weekday of a day key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The Monday of the ISO week holding `key` (weeks run Monday to Sunday). */
export function mondayOf(key: string): string {
  return addDays(key, 1 - isoWeekday(key));
}

export function emptyDay(date: string): DayStats {
  return {
    date,
    studyMinutes: 0,
    reviews: 0,
    correct: 0,
    newItems: 0,
    sessionComplete: false,
    minimumDone: false,
    togetherMinutes: 0,
    restToken: false,
    accuracyShared: false,
  };
}

/** One entry per day of `window`, using `days` where present and zeros elsewhere. */
export function fillDays(window: readonly string[], days: readonly DayStats[]): DayStats[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return window.map((date) => byDate.get(date) ?? emptyDay(date));
}

/**
 * Consecutive days on which every member studied (v1 clients' "shared streak"). The run may end today or
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

// ---------------------------------------------------------------------------
// Couple quest: every member ≥ 5 minimum days and sessions A, B and C in a week, with one reserve
// a calendar month that covers a single shortfall.
// ---------------------------------------------------------------------------

const QUEST_MINIMUM_DAYS = 5;
const QUEST_SESSIONS = 3;
const LETTERS: readonly TogetherSessionId[] = ['A', 'B', 'C'];

export interface CoupleQuestInput {
  /** Monday 'YYYY-MM-DD'. */
  week: string;
  today: string;
  members: readonly string[];
  /** memberId → dates with minimum_done or session_complete. */
  minimumDates: Readonly<Record<string, ReadonlySet<string>>>;
  /** Dates with any together session (they count for every member). */
  togetherDates: ReadonlySet<string>;
  /** Session ids with a session-done this week. */
  sessionsDone: ReadonlySet<TogetherSessionId>;
  reserveUsedEarlierThisMonth: boolean;
}

/** One week's quest (pure). */
export function coupleQuest(input: CoupleQuestInput): CoupleQuest {
  const dates = lastDays(addDays(input.week, 6), 7);
  const minimumDays: Record<string, number> = {};
  for (const member of input.members) {
    const own = input.minimumDates[member];
    minimumDays[member] = dates.filter((date) => own?.has(date) || input.togetherDates.has(date)).length;
  }
  const letters = LETTERS.filter((letter) => input.sessionsDone.has(letter)).length;
  // The monthly session stands in for one missing letter, never more: two evenings never make three.
  const togetherSessions = Math.min(
    QUEST_SESSIONS,
    letters + (input.sessionsDone.has('monthly') && letters < QUEST_SESSIONS ? 1 : 0),
  );
  const shortfall =
    input.members.reduce((sum, member) => sum + Math.max(0, QUEST_MINIMUM_DAYS - minimumDays[member]), 0) +
    Math.max(0, QUEST_SESSIONS - togetherSessions);
  const met = shortfall === 0 || (shortfall === 1 && !input.reserveUsedEarlierThisMonth);
  const reserveUsed = shortfall === 1 && met;
  const sunday = addDays(input.week, 6);
  const daysLeft =
    input.today < input.week ? 7 : input.today > sunday ? 0 : 7 - (isoWeekday(input.today) - 1);
  return {
    week: input.week,
    minimumDays,
    togetherSessions,
    shortfall,
    met,
    reserveUsed,
    reserveLeft: !input.reserveUsedEarlierThisMonth && !reserveUsed,
    daysLeft,
  };
}

/** Everything the quest needs about the household, over as many weeks as were loaded. */
export interface QuestHistory {
  members: readonly string[];
  minimumDates: Readonly<Record<string, ReadonlySet<string>>>;
  togetherDates: ReadonlySet<string>;
  /** Monday → session ids done that week. */
  sessionsByWeek: ReadonlyMap<string, ReadonlySet<TogetherSessionId>>;
}

/**
 * The quest of `week` as of `today`. The reserve belongs to the calendar month of the week's
 * Monday; the month's earlier weeks are evaluated first, in order, so whether it is still left is
 * deterministic.
 */
export function questForWeek(history: QuestHistory, week: string, today: string): CoupleQuest {
  const memo = new Map<string, CoupleQuest>();
  return evaluateWeek(history, week, today, memo);
}

function evaluateWeek(history: QuestHistory, week: string, today: string, memo: Map<string, CoupleQuest>): CoupleQuest {
  const cached = memo.get(week);
  if (cached) return cached;
  let reserveUsedEarlierThisMonth = false;
  for (let earlier = addDays(week, -7); earlier.slice(0, 7) === week.slice(0, 7); earlier = addDays(earlier, -7)) {
    if (evaluateWeek(history, earlier, today, memo).reserveUsed) {
      reserveUsedEarlierThisMonth = true;
      break;
    }
  }
  const quest = coupleQuest({
    week,
    today,
    members: history.members,
    minimumDates: history.minimumDates,
    togetherDates: history.togetherDates,
    sessionsDone: history.sessionsByWeek.get(week) ?? new Set(),
    reserveUsedEarlierThisMonth,
  });
  memo.set(week, quest);
  return quest;
}

/**
 * Consecutive weeks with the quest met, walking back from `week`. This week counts only once met;
 * until then the run up to last week still counts. At most `maxWeeks` are looked at.
 */
export function questStreakWeeks(history: QuestHistory, week: string, today: string, maxWeeks = 104): number {
  const memo = new Map<string, CoupleQuest>();
  let current = evaluateWeek(history, week, today, memo).met ? week : addDays(week, -7);
  let streak = 0;
  while (streak < maxWeeks && evaluateWeek(history, current, today, memo).met) {
    streak++;
    current = addDays(current, -7);
  }
  return streak;
}
