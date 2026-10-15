import type { TogetherSessionId, TogetherState } from '../../shared/api.ts';
import type { StoredTogetherEvent } from './db.ts';
import { addDays, mondayOf, type QuestHistory } from './days.ts';

/** How far back TogetherState reaches (the phones plan from these). */
const SESSION_WEEKS = 12;
const TASK_DAYS = 60;
const CHECKIN_WEEKS = 26;
/** Stage 5 means the script's conversation is finished. */
const FINISHED_STAGE = 5;

/**
 * Folds the household's together events (in arrival order) into the state the phones plan from.
 * Pure. `members` are the current member ids; `today` is the household's study day.
 *
 * - `slots` and `goal`: the latest event wins.
 * - `smooth`: a member's mark counts only for the script's current stage. When every current member
 *   marked it, or one phone marked it for both, the stage advances (5 = finished) and the marks clear.
 * - `session-done`: one entry per (week, session, date), the first one reported.
 * - `task-done` and `capstone-done`: appended once each; `checkin`: one per member and week, the latest.
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
  const sessionKeys = new Set<string>();
  const marks = new Map<string, Set<string>>();

  for (const { memberId, week, event } of [...events].sort((a, b) => a.id - b.id)) {
    switch (event.type) {
      case 'slots':
        state.slots = event.slots;
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
        if (sessionWeek < sessionsFrom || sessionKeys.has(key)) break;
        sessionKeys.add(key);
        state.sessions.push({ week: sessionWeek, session: event.session, date: event.date, minutes: event.minutes, memberId });
        break;
      }
      case 'task-done': {
        if (event.date < tasksFrom) break;
        const known = state.tasks.some(
          (task) => task.taskId === event.taskId && task.date === event.date && task.repeat === event.repeat,
        );
        if (!known) state.tasks.push({ taskId: event.taskId, date: event.date, repeat: event.repeat });
        break;
      }
      case 'checkin': {
        if (week < checkinsFrom) break;
        state.checkins = state.checkins.filter((entry) => !(entry.week === week && entry.memberId === memberId));
        state.checkins.push({ week, memberId, checkin: event.checkin });
        break;
      }
      case 'capstone-done': {
        const known = state.capstones.some((entry) => entry.unit === event.unit && entry.date === event.date);
        if (!known) state.capstones.push({ unit: event.unit, date: event.date });
        break;
      }
    }
  }

  for (const [scriptId, marked] of marks) state.smooth[scriptId] = [...marked];
  return state;
}

/**
 * The quest's view of the together events: the dates with a together session (a minimum day for
 * every member) and the sessions done per week, each (session, date) once.
 */
export function togetherQuestHistory(
  events: readonly StoredTogetherEvent[],
): Pick<QuestHistory, 'togetherDates' | 'sessionsByWeek'> {
  const togetherDates = new Set<string>();
  const sessionsByWeek = new Map<string, Set<TogetherSessionId>>();
  for (const { event } of events) {
    if (event.type !== 'session-done') continue;
    togetherDates.add(event.date);
    const week = mondayOf(event.date);
    const done = sessionsByWeek.get(week) ?? new Set<TogetherSessionId>();
    done.add(event.session);
    sessionsByWeek.set(week, done);
  }
  return { togetherDates, sessionsByWeek };
}
