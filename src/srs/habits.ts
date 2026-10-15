// Habits: the minimum day, the streak with rest tokens, repair by a make-up
// session, the comeback offers after a gap, travel mode and the fresh start.
// Copy rule for the UI: "N days studied this month", "Longest streak N", the
// current streak only while alive, and never a missed-days count.

import { State } from 'ts-fsrs';
import { dayKey, db, getSettings, updateSettings } from '../lib/db.ts';
import type { DayRecord, RestTokenRecord, TogetherSessionId } from '../lib/types.ts';
import { addDays, dayStart, getDay, isStudyDay, normalizeDay, updateDay, weekStart } from './days.ts';

export const TOKENS_PER_WEEK = 2;
export const REPAIR_HOURS = 48;
export const REPAIR_MIN_MS = 10 * 60_000;
export const MINIMUM_REVIEW_MS = 5 * 60_000;
/** Days a fresh start or welcome-back looks back over, and the most a token can reach back. */
export const TOKEN_LOOKBACK_DAYS = 7;
export const TRAVEL_MAX_DAYS = 60;

export type HabitDayStatus = 'goal' | 'done' | 'rest' | 'repaired' | 'travel' | 'missed' | 'today' | 'future' | 'before';
export interface HabitDay { date: string; minimumDone: boolean; goalMet: boolean; token: boolean; repaired: boolean; travel: boolean }
export interface StreakV2 {
  /** Minimum days in the current run (rest tokens keep it alive but add nothing). 0 when broken. */
  current: number;
  /** current > 0 or today is the run's first day: the UI shows the current streak only when alive. */
  alive: boolean;
  longest: number;
  daysThisMonth: number;
  todayMinimum: boolean;
  todayGoal: boolean;
  tokensLeftThisWeek: number;
  /** Most recent uncovered missed day still repairable, with its deadline (4 a.m. after that day + 48 h). Only when
   *  that day's ISO week has no rest token left (the token is always offered first), and only when every uncovered
   *  missed day of its gap can still be repaired: otherwise repairing it could not save the run. */
  repairable?: { date: string; deadline: Date };
  /** repairable is set and today's goal is met: Today and the Session summary offer the 10-minute make-up. */
  makeupOffer: boolean;
  /** Yesterday was missed, uncovered, its week has a token left, and it is the gap's only uncovered missed day (a
   *  token for it keeps the run alive): Today asks "Use a rest token for yesterday?". */
  offerTokenFor?: string;
  /** Monday → Sunday of this week. */
  week: { date: string; status: HabitDayStatus }[];
}

const emptyHabitDay = (date: string): HabitDay => ({ date, minimumDone: false, goalMet: false, token: false, repaired: false, travel: false });

/** A past day that neither counted nor was covered. */
function isMissed(h: HabitDay): boolean {
  return !h.minimumDone && !h.token && !h.repaired && !h.travel;
}

/** The 4 a.m. that ends `date`, plus 48 hours. */
export function repairDeadline(date: string): Date {
  const end = dayStart(addDays(date, 1));
  return new Date(end.getTime() + REPAIR_HOURS * 60 * 60 * 1000);
}

/**
 * pure. Walks start → today: a day keeps the run when minimumDone, token or repaired; travel days neither break nor count;
 * any other past day breaks it; today never breaks it.
 */
export function streakFromHabitDays(days: readonly HabitDay[], today: string, start: string, now: Date): StreakV2 {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const get = (date: string) => byDate.get(date) ?? emptyHabitDay(date);

  let current = 0;
  let longest = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const h = get(d);
    if (h.minimumDone) {
      current++;
      longest = Math.max(longest, current);
    } else if (h.token || h.repaired || h.travel || d === today) {
      // Kept alive (or not over yet), adds nothing.
    } else {
      current = 0;
    }
  }

  const month = today.slice(0, 7);
  const daysThisMonth = days.filter((d) => d.minimumDone && d.date.startsWith(month) && d.date <= today).length;
  const tokensIn = (week: string) => days.filter((d) => d.token && weekStart(d.date) === week).length;
  const thisWeek = weekStart(today);

  /**
   * The uncovered missed days of the gap around a missed `date`: the days before today with no minimum day on either
   * side of it (token, travel and repaired days are skipped, as comebackOffer walks).
   */
  const gapOf = (date: string): string[] => {
    const out: string[] = [];
    for (let d = date; d >= start && !get(d).minimumDone; d = addDays(d, -1)) if (isMissed(get(d))) out.push(d);
    for (let d = addDays(date, 1); d < today && !get(d).minimumDone; d = addDays(d, 1)) if (isMissed(get(d))) out.push(d);
    return out;
  };
  const stillRepairable = (date: string) => repairDeadline(date).getTime() > now.getTime();

  let repairable: StreakV2['repairable'];
  for (let back = 1; back <= 3; back++) {
    const date = addDays(today, -back);
    if (date < start) break;
    const deadline = repairDeadline(date);
    if (deadline.getTime() <= now.getTime()) break;
    if (isMissed(get(date)) && tokensIn(weekStart(date)) >= TOKENS_PER_WEEK) {
      // A day whose gap holds a day past its deadline can't save the run (a gap of 3 days or more): no make-up.
      if (gapOf(date).every(stillRepairable)) repairable = { date, deadline };
      break;
    }
  }

  const yesterday = addDays(today, -1);
  const offerTokenFor =
    yesterday >= start && isMissed(get(yesterday)) && tokensIn(weekStart(yesterday)) < TOKENS_PER_WEEK && gapOf(yesterday).length === 1
      ? yesterday
      : undefined;

  const todayDay = get(today);
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(thisWeek, i);
    const h = get(date);
    let status: HabitDayStatus;
    if (date > today) status = h.token ? 'rest' : h.travel ? 'travel' : 'future';
    else if (date < start) status = 'before';
    else if (h.goalMet) status = 'goal';
    else if (h.minimumDone) status = 'done';
    else if (h.repaired) status = 'repaired';
    else if (h.token) status = 'rest';
    else if (h.travel) status = 'travel';
    else if (date === today) status = 'today';
    else status = 'missed';
    return { date, status };
  });

  return {
    current,
    alive: current > 0 || start === today,
    longest,
    daysThisMonth,
    todayMinimum: todayDay.minimumDone,
    todayGoal: todayDay.goalMet,
    tokensLeftThisWeek: Math.max(0, TOKENS_PER_WEEK - tokensIn(thisWeek)),
    ...(repairable ? { repairable } : {}),
    makeupOffer: repairable !== undefined && todayDay.goalMet,
    ...(offerTokenFor ? { offerTokenFor } : {}),
    week,
  };
}

/**
 * The learner's first day on this phone: the earliest study day or item introduced by studying, else today. Items the
 * placement check marked known do not count: onboarding the evening before the first session must not leave a
 * "missed" day (with a rest-token and welcome-back offer) at the start of the streak.
 */
export async function firstStudyDay(now: Date = new Date()): Promise<string> {
  const today = dayKey(now);
  const [days, firstItem] = await Promise.all([
    db.days.toArray(),
    db.items.orderBy('introducedAt').filter((i) => i.via !== 'placement').first(),
  ]);
  const candidates = [today];
  const firstDay = days.filter((d) => d.date <= today && isStudyDay(normalizeDay(d, d.date))).map((d) => d.date).sort()[0];
  if (firstDay) candidates.push(firstDay);
  if (firstItem) candidates.push(dayKey(firstItem.introducedAt));
  return candidates.sort()[0];
}

function habitDay(row: DayRecord, tokens: ReadonlySet<string>): HabitDay {
  return {
    date: row.date,
    minimumDone: row.minimumDone,
    goalMet: row.goalMet,
    token: tokens.has(row.date),
    repaired: row.repaired ?? false,
    travel: row.travel ?? false,
  };
}

async function habitDays(): Promise<HabitDay[]> {
  const [rows, tokens] = await Promise.all([db.days.toArray(), db.restTokens.toArray()]);
  const tokenDays = new Set(tokens.map((t) => t.date));
  const out = new Map(rows.map((r) => [r.date, habitDay(normalizeDay(r, r.date), tokenDays)]));
  for (const t of tokens) if (!out.has(t.date)) out.set(t.date, { ...emptyHabitDay(t.date), token: true });
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function streak(now: Date = new Date()): Promise<StreakV2> {
  const [days, start] = await Promise.all([habitDays(), firstStudyDay(now)]);
  return streakFromHabitDays(days, dayKey(now), start, now);
}

/**
 * A token for `date`: allowed for a missed past day (within its own ISO week's limit) or a future day (planned).
 * The third token in one ISO week → 'none-left'.
 */
export function spendRestToken(date: string, now: Date = new Date()): Promise<'ok' | 'none-left' | 'already' | 'not-allowed'> {
  const today = dayKey(now);
  return db.transaction('rw', db.restTokens, db.days, async () => {
    if (await db.restTokens.get(date)) return 'already';
    if (date === today || date < addDays(today, -TOKEN_LOOKBACK_DAYS)) return 'not-allowed';
    if (date < today) {
      const day = await getDay(date);
      if (day.minimumDone || day.travel || day.repaired) return 'not-allowed';
    }
    const week = weekStart(date);
    if ((await db.restTokens.where('week').equals(week).count()) >= TOKENS_PER_WEEK) return 'none-left';
    const token: RestTokenRecord = { date, week, usedAt: now };
    await db.restTokens.add(token);
    return 'ok';
  });
}

/** Takes back a token planned for a future day. */
export async function cancelPlannedToken(date: string, now: Date = new Date()): Promise<void> {
  if (date > dayKey(now)) await db.restTokens.delete(date);
}

/**
 * After every graded answer: minimumDone when reviewMs today ≥ 5 min, or ≥ 1 review today and the warm-up candidate
 * list is empty (the planToday filter: not New, not of an item introduced today, not buried until a later day).
 */
export function noteReviewProgress(now: Date = new Date()): Promise<boolean> {
  const today = dayKey(now);
  return db.transaction('rw', db.days, db.cards, db.items, async () => {
    const day = await getDay(today);
    if (day.minimumDone) return true;
    let done = day.reviewMs >= MINIMUM_REVIEW_MS;
    if (!done && day.reviews >= 1) {
      const due = (await db.cards.where('due').belowOrEqual(now).toArray()).filter((c) => !c.suspended && c.state !== State.New);
      const items = await db.items.bulkGet([...new Set(due.map((c) => c.itemId))]);
      const introducedToday = new Set(items.filter((i) => i && dayKey(i.introducedAt) === today).map((i) => i!.id));
      done = due.every((c) => introducedToday.has(c.itemId));
    }
    if (done) {
      await updateDay(today, (d) => {
        d.minimumDone = true;
      });
    }
    return done;
  });
}

/** A 3-minute micro or welcome-back session finished: minimumDone. Idempotent. */
export async function completeMicro(now: Date = new Date()): Promise<void> {
  await updateDay(dayKey(now), (d) => {
    d.minimumDone = true;
  });
}

/** A full plan's steps are all done: goalMet + minimumDone. Idempotent. It never repairs a missed day. */
export async function completeDay(now: Date = new Date()): Promise<StreakV2> {
  await updateDay(dayKey(now), (d) => {
    d.goalMet = true;
    d.minimumDone = true;
  });
  return streak(now);
}

/**
 * End of a make-up session: when DayRecord.makeupMs today ≥ REPAIR_MIN_MS and `repairable` is set, the missed day's
 * row gets repaired = true, and the 10 minutes are used up (a second call, or a second missed day, needs another
 * make-up). Idempotent; returns whether a day was repaired.
 */
export function completeMakeup(now: Date = new Date()): Promise<boolean> {
  const today = dayKey(now);
  return db.transaction('rw', db.days, db.restTokens, db.items, async () => {
    const day = await getDay(today);
    if ((day.makeupMs ?? 0) < REPAIR_MIN_MS) return false;
    const { repairable } = await streak(now);
    if (!repairable) return false;
    await updateDay(repairable.date, (d) => {
      d.repaired = true;
    });
    await updateDay(today, (d) => {
      d.makeupMs = Math.max(0, (d.makeupMs ?? 0) - REPAIR_MIN_MS);
    });
    return true;
  });
}

/**
 * A together session counted for this member on `date` (it counts for both partners, whoever's phone ran it):
 * togetherMs += minutes·60 000 and minimumDone, only when `session` is not yet in DayRecord(date).together (then
 * added). Idempotent, so E (the phone that ran it) and F (every 'together' event and refresh) can both call it.
 */
export function creditTogetherSession(session: TogetherSessionId, minutes: number, date: string, _now: Date = new Date()): Promise<boolean> {
  return db.transaction('rw', db.days, async () => {
    const day = await getDay(date);
    if (day.together?.includes(session)) return false;
    await updateDay(date, (d) => {
      d.together = [...(d.together ?? []), session];
      d.togetherMs += Math.max(0, Number.isFinite(minutes) ? minutes : 0) * 60_000;
      d.minimumDone = true;
    });
    return true;
  });
}

export interface ComebackOffer { kind: 'none' | 'welcome-back' | 'fresh-start'; missedDays: number; freshStart?: string }

export const FRESH_START_AFTER = 3;

/** pure: the first Monday or 1st of the month after `today`, whichever comes first. */
export function nextFreshStart(today: string): string {
  const monday = addDays(weekStart(today), 7);
  const [y, m] = today.split('-').map(Number);
  const first = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return monday < first ? monday : first;
}

/**
 * pure. Consecutive uncovered missed days right before today (travel and token days don't count):
 * ≥ 1 → welcome-back; ≥ 3 → fresh-start, freshStart = whichever comes first after today: next Monday or the 1st.
 * Days before the first one listed are the time before the learner started.
 */
export function comebackOffer(days: readonly HabitDay[], today: string): ComebackOffer {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days.reduce<string | undefined>((min, d) => (min === undefined || d.date < min ? d.date : min), undefined);
  let missed = 0;
  for (let d = addDays(today, -1); first !== undefined && d >= first; d = addDays(d, -1)) {
    const h = byDate.get(d) ?? emptyHabitDay(d);
    if (h.minimumDone) break;
    if (h.token || h.travel || h.repaired) continue;
    missed++;
  }
  if (missed >= FRESH_START_AFTER) return { kind: 'fresh-start', missedDays: missed, freshStart: nextFreshStart(today) };
  if (missed >= 1) return { kind: 'welcome-back', missedDays: missed };
  return { kind: 'none', missedDays: 0 };
}

/** The comeback offer for today. */
export async function comeback(now: Date = new Date()): Promise<ComebackOffer> {
  const [days, start] = await Promise.all([habitDays(), firstStudyDay(now)]);
  const today = dayKey(now);
  const span = days.filter((d) => d.date >= start && d.date < today);
  return comebackOffer(span.some((d) => d.date === start) ? span : [emptyHabitDay(start), ...span], today);
}

/**
 * Travel/sick mode: Settings.travelUntil (null ends it). Days inside get DayRecord.travel (today up to `until`), so
 * they neither count nor break the streak even when the app is never opened. Ending it early clears the days after
 * today. Catch-up runs on return.
 */
export async function setTravel(until: string | null, now: Date = new Date()): Promise<void> {
  const today = dayKey(now);
  await updateSettings({ travelUntil: until ?? undefined });
  await db.transaction('rw', db.days, async () => {
    if (until) {
      for (let d = today, n = 0; d <= until && n < TRAVEL_MAX_DAYS; d = addDays(d, 1), n++) {
        await updateDay(d, (row) => {
          row.travel = true;
        });
      }
    }
    const later = await db.days.where('date').above(until ?? today).toArray();
    for (const row of later) {
      if (!row.travel) continue;
      await updateDay(row.date, (d) => {
        delete d.travel;
      });
    }
    if (!until) {
      const day = await getDay(today);
      if (day.travel && !isStudyDay(day)) {
        await updateDay(today, (d) => {
          delete d.travel;
        });
      }
    }
  });
}

/** Saves Settings.freshStart (the offer's date). */
export async function chooseFreshStart(date: string, _now: Date = new Date()): Promise<void> {
  await updateSettings({ freshStart: date });
}

/** pure: course weeks 4 and 8 from the first study day: [+28 d, +56 d]. */
export function planReviewDays(firstDay: string): string[] {
  return [addDays(firstDay, 28), addDays(firstDay, 56)];
}

/** Whether travel mode covers today. */
export async function travelling(now: Date = new Date()): Promise<boolean> {
  const { travelUntil } = await getSettings();
  return travelUntil !== undefined && travelUntil >= dayKey(now);
}
