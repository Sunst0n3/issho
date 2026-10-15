import type { TogetherEvent, TogetherSessionId, TogetherState } from '../../shared/api.ts';
import type { StoredTogetherEvent } from './db.ts';
import { addDays, mondayOf, type QuestHistory } from './days.ts';

/** How far back TogetherState reaches (the phones plan from these). */
const SESSION_WEEKS = 12;
const TASK_DAYS = 60;
const CHECKIN_WEEKS = 26;
/** Stage 5 means the script's conversation is finished. */
const FINISHED_STAGE = 5;
/**
 * How far past the household's today an event may be dated: a phone whose clock or time zone runs
 * a little ahead. Anything later is a wrong clock, and never credits sessions, letters or days.
 */
export const FUTURE_SKEW_DAYS = 1;

/** The newest date an event may carry on `today`. */
export function latestEventDate(today: string): string {
  return addDays(today, FUTURE_SKEW_DAYS);
}

/**
 * The newest week an event may be filed under on `today`: the week of the newest date, or the
 * week after it for `slots`, which the check-in plans for next week.
 */
export function latestEventWeek(today: string, type: TogetherEvent['type']): string {
  const week = mondayOf(latestEventDate(today));
  return type === 'slots' ? addDays(week, 7) : week;
}

/**
 * Folds the household's together events (in arrival order) into the state the phones plan from.
 * Pure. `members` are the current member ids; `today` is the household's study day.
 *
 * - `slots`: of the events filed under this week or earlier, the one filed under the latest week wins (the newest
 *   of that week), so a change saved for this week later never undoes a check-in's plan for a week now begun. One
 *   filed under a later week (the check-in's "next week's sessions") waits for that week, so this week's sessions
 *   stay put; meanwhile it is `nextSlots`.
 * - `goal`: the latest event wins.
 * - `smooth`: a member's mark counts only for the script's current stage. When every current member
 *   marked it, or one phone marked it for both, the stage advances (5 = finished) and the marks clear.
 * - `session-done`: one entry per (week, session, date), the first one reported.
 * - `task-done` and `capstone-done`: appended once each; `checkin`: one per member and week, the latest.
 * - Events dated after today (beyond FUTURE_SKEW_DAYS) come from a wrong clock and are ignored.
 */
export function foldTogether(
  events: readonly StoredTogetherEvent[],
  members: readonly string[],
  today: string,
): TogetherState {
  const state: TogetherState = {
    slots: [],
    goal: null,
    stages: {},
    smooth: {},
    sessions: [],
    tasks: [],
    checkins: [],
    capstones: [],
  };
  const thisWeek = mondayOf(today);
  const sessionsFrom = addDays(thisWeek, -7 * (SESSION_WEEKS - 1));
  const tasksFrom = addDays(today, -(TASK_DAYS - 1));
  const checkinsFrom = addDays(thisWeek, -7 * (CHECKIN_WEEKS - 1));
  const latestDate = latestEventDate(today);
  const latestWeek = mondayOf(latestDate);
  const sessionKeys = new Set<string>();
  const marks = new Map<string, Set<string>>();
  /** The week the slots in effect were filed under, and the plan waiting for a later week. */
  let slotsWeek = '';
  let waiting: { week: string; slots: TogetherState['slots'] } | undefined;

  for (const { memberId, week, event } of [...events].sort((a, b) => a.id - b.id)) {
    switch (event.type) {
      case 'slots':
        if (week <= thisWeek) {
          if (week >= slotsWeek) {
            state.slots = event.slots;
            slotsWeek = week;
          }
        } else if (!waiting || week >= waiting.week) {
          waiting = { week, slots: event.slots };
        }
        break;
      case 'goal':
        state.goal = event.goal;
        break;
      case 'smooth': {
        const stage = state.stages[event.scriptId] ?? 1;
        if (event.stage !== stage || stage >= FINISHED_STAGE) break;
        const marked = marks.get(event.scriptId) ?? new Set<string>();
        marked.add(memberId);
        if (event.both || members.every((member) => marked.has(member))) {
          state.stages[event.scriptId] = stage + 1;
          marks.delete(event.scriptId);
        } else {
          marks.set(event.scriptId, marked);
        }
        break;
      }
      case 'session-done': {
        // Filed under the week of the day it happened, whenever a phone got round to sending it.
        const sessionWeek = mondayOf(event.date);
        const key = `${sessionWeek}|${event.session}|${event.date}`;
        if (sessionWeek < sessionsFrom || event.date > latestDate || sessionKeys.has(key)) break;
        sessionKeys.add(key);
        state.sessions.push({ week: sessionWeek, session: event.session, date: event.date, minutes: event.minutes, memberId });
        break;
      }
      case 'task-done': {
        if (event.date < tasksFrom || event.date > latestDate) break;
        const known = state.tasks.some(
          (task) => task.taskId === event.taskId && task.date === event.date && task.repeat === event.repeat,
        );
        if (!known) state.tasks.push({ taskId: event.taskId, date: event.date, repeat: event.repeat });
        break;
      }
      case 'checkin': {
        if (week < checkinsFrom || week > latestWeek) break;
        state.checkins = state.checkins.filter((entry) => !(entry.week === week && entry.memberId === memberId));
        state.checkins.push({ week, memberId, checkin: event.checkin });
        break;
      }
      case 'capstone-done': {
        if (event.date > latestDate) break;
        const known = state.capstones.some((entry) => entry.unit === event.unit && entry.date === event.date);
        if (!known) state.capstones.push({ unit: event.unit, date: event.date });
        break;
      }
    }
  }

  for (const [scriptId, marked] of marks) state.smooth[scriptId] = [...marked];
  if (waiting) state.nextSlots = waiting.slots;
  return state;
}

/**
 * The quest's view of the together events: the dates with a together session (a minimum day for
 * every member) and the sessions done per week, each (session, date) once. Sessions dated after
 * `today` (beyond the clock-skew allowance) are ignored, as in the fold.
 */
export function togetherQuestHistory(
  events: readonly StoredTogetherEvent[],
  today: string,
): Pick<QuestHistory, 'togetherDates' | 'sessionsByWeek'> {
  const latestDate = latestEventDate(today);
  const togetherDates = new Set<string>();
  const sessionsByWeek = new Map<string, Set<TogetherSessionId>>();
  for (const { event } of events) {
    if (event.type !== 'session-done' || event.date > latestDate) continue;
    togetherDates.add(event.date);
    const week = mondayOf(event.date);
    const done = sessionsByWeek.get(week) ?? new Set<TogetherSessionId>();
    done.add(event.session);
    sessionsByWeek.set(week, done);
  }
  return { togetherDates, sessionsByWeek };
}
