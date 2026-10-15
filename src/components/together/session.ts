// A together session's run: its steps, and the live state two phones keep in step.
//
// Duo: the phone that opens the session first is the opener. Its plan (script, stage, task,
// story, capstone) travels in the live state and the joiner runs exactly that plan. Positions
// (step, index, turn, timer) only move forward, so either phone may ask to go on: the other
// one adopts any position ahead of its own, and the opener repeats its state so a phone that
// missed an event catches up. Where a session ends with a part each phone does for itself (its
// smooth mark, private recap or check-in), a phone waits there for its own tap. Pass-and-play
// keeps the same state on one phone.

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { TogetherLiveState, TogetherRunPlan, TogetherSessionId } from '../../../shared/api.ts';
import type { TogetherWeekPlan } from '../../lib/types.ts';
import { onLive, sendLive } from '../../sync/together.ts';

/** quizIds value for "this phone had nothing to quiz", so the asker doesn't wait for a quiz. */
export const NO_QUIZ = 'none';
/** A waiting opener repeats its state this often; an invite not repeated for INVITE_TTL_MS is gone. */
export const LIVE_REPEAT_MS = 3_000;
export const INVITE_TTL_MS = 10_000;

export type SessionStep =
  | 'quiz'
  | 'teach-me'
  | 'conversation'
  | 'task'
  | 'plan'
  | 'run'
  | 'swap'
  | 'outcome'
  | 'recap'
  | 'roleplay'
  | 'story'
  | 'retell'
  | 'dictation'
  | 'showcase'
  | 'checkin'
  | 'goal'
  | 'capstone'
  | 'done';

export const SESSION_TITLES: Record<TogetherSessionId, string> = {
  A: 'Quiz & conversation',
  B: 'Task together',
  C: 'Story, game & check-in',
  monthly: 'Monthly session',
};

/** The steps of a session, given the plan it runs. */
export function sessionSteps(session: TogetherSessionId, plan: TogetherRunPlan): SessionStep[] {
  const steps: SessionStep[] = [];
  switch (session) {
    case 'A':
      steps.push('quiz', 'teach-me');
      if (plan.conversation) steps.push('conversation');
      break;
    case 'B':
      if (plan.task) steps.push('task', 'plan', 'run', 'swap', 'outcome', 'recap');
      else if (plan.rolePlayId) steps.push('roleplay');
      break;
    case 'C':
      if (plan.storyId) steps.push('story');
      steps.push('retell', plan.showcase ? 'showcase' : 'dictation', 'checkin');
      break;
    case 'monthly':
      steps.push('quiz', 'goal');
      if (plan.capstoneUnit) steps.push('capstone');
      break;
  }
  steps.push('done');
  return steps;
}

/** What the opener's phone runs this week: the parts of its week plan that both phones must agree on. */
export function runPlanOf(week: Pick<TogetherWeekPlan, 'conversation' | 'task' | 'rolePlayId' | 'storyId' | 'capstoneUnit' | 'showcase'>): TogetherRunPlan {
  const plan: TogetherRunPlan = {};
  if (week.conversation) plan.conversation = { ...week.conversation };
  if (week.task) plan.task = { ...week.task };
  if (week.rolePlayId) plan.rolePlayId = week.rolePlayId;
  if (week.storyId) plan.storyId = week.storyId;
  if (week.capstoneUnit) plan.capstoneUnit = week.capstoneUnit;
  if (week.showcase) plan.showcase = true;
  return plan;
}

export function isSessionId(id: string | undefined): id is TogetherSessionId {
  return id === 'A' || id === 'B' || id === 'C' || id === 'monthly';
}

type Position = Pick<TogetherLiveState, 'step' | 'index'> & Partial<Pick<TogetherLiveState, 'turn' | 'opener'>>;

/**
 * 0 while the opener has the turn, 1 once it has passed to the partner. Within a step the turn
 * only ever goes opener → partner (the quiz's two directions, the teach-me turns), and handing it
 * over starts the index again at 0.
 */
function turnPhase(p: Position): number {
  return p.turn && p.opener && p.turn !== p.opener ? 1 : 0;
}

/**
 * Steps each phone finishes for itself in duo: each partner's own smooth / again mark at the end
 * of the conversation, the private recap, and each partner's check-in. A phone on one of them
 * never follows the partner's phone past it (the slower partner would lose their mark, recap or
 * check-in); it moves on with its own tap. Each is the last step of its session.
 */
export const OWN_STEPS: ReadonlySet<string> = new Set<SessionStep>(['conversation', 'recap', 'checkin']);

/** Orders two positions: by step, then by whose turn it is, then by index within the turn. */
export function comparePosition(steps: readonly string[], a: Position, b: Position): number {
  const sa = steps.indexOf(a.step);
  const sb = steps.indexOf(b.step);
  if (sa !== sb) return sa - sb;
  const ta = turnPhase(a);
  const tb = turnPhase(b);
  if (ta !== tb) return ta - tb;
  return (a.index ?? 0) - (b.index ?? 0);
}

export function openLive(input: {
  sessionId: string;
  session: TogetherSessionId;
  me: string;
  plan: TogetherRunPlan;
  steps: readonly SessionStep[];
  /** Pass-and-play starts at once; duo waits for the partner. */
  waiting: boolean;
}): TogetherLiveState {
  return {
    sessionId: input.sessionId,
    session: input.session,
    opener: input.me,
    plan: input.plan,
    quizIds: {},
    step: input.steps[0],
    index: 0,
    turn: input.me,
    status: input.waiting ? 'waiting' : 'active',
  };
}

/** The joiner takes the opener's state as it is: its plan, step and turn. */
export function joinLive(remote: TogetherLiveState): TogetherLiveState {
  return { ...remote, quizIds: { ...remote.quizIds }, status: remote.status === 'done' ? 'done' : 'active' };
}

/**
 * Merges the partner phone's state into this phone's. Positions only move forward, except past a
 * step this phone finishes for itself (OWN_STEPS); quiz ids are a union (each phone adds only its
 * own); the plan is the opener's.
 */
export function mergeLive(
  local: TogetherLiveState,
  remote: TogetherLiveState,
  steps: readonly string[],
  remoteMemberId: string,
): TogetherLiveState {
  if (remote.sessionId !== local.sessionId) return local;
  const quizIds = { ...remote.quizIds, ...local.quizIds };
  const theirs = remote.quizIds?.[remoteMemberId];
  if (theirs) quizIds[remoteMemberId] = theirs;
  let next: TogetherLiveState = { ...local, quizIds, plan: local.plan ?? remote.plan };
  const order = comparePosition(steps, remote, local);
  // The partner finished a step this phone still has its own part of: stay until this phone's own tap.
  const holding = order > 0 && remote.step !== local.step && OWN_STEPS.has(local.step);
  if (order > 0 && !holding) {
    next = { ...next, step: remote.step, index: remote.index, turn: remote.turn, timerStartedAt: remote.timerStartedAt };
  } else if (order === 0) {
    // Same place: a timer started on either phone runs on both; the opener's turn stands.
    if (remote.timerStartedAt && !local.timerStartedAt) next = { ...next, timerStartedAt: remote.timerStartedAt };
    if (remote.turn && remote.turn !== local.turn && remoteMemberId === local.opener) next = { ...next, turn: remote.turn };
  }
  // A phone held on its own step hears that the session is over too: it stops repeating its state,
  // so the partner's Together tab no longer offers to join, while it finishes its part.
  if (remote.status === 'done' || local.status === 'done') next = { ...next, status: 'done' };
  else if (local.status === 'waiting' && remote.status === 'active') next = { ...next, status: 'active' };
  // A heartbeat that changes nothing keeps this phone's state as it is (no re-render every few seconds).
  return sameLive(local, next) ? local : next;
}

function sameLive(a: TogetherLiveState, b: TogetherLiveState): boolean {
  if (a.step !== b.step || a.index !== b.index || a.turn !== b.turn || a.timerStartedAt !== b.timerStartedAt
    || a.status !== b.status || a.plan !== b.plan) return false;
  const qa = a.quizIds ?? {};
  const qb = b.quizIds ?? {};
  const keys = Object.keys(qa);
  return keys.length === Object.keys(qb).length && keys.every((k) => qa[k] === qb[k]);
}

/** Moves to the next step (index, timer reset; the turn goes back to the opener). */
export function nextStep(state: TogetherLiveState, steps: readonly SessionStep[]): TogetherLiveState {
  const at = steps.indexOf(state.step as SessionStep);
  const step = steps[Math.min(steps.length - 1, at + 1)];
  return {
    ...state,
    step,
    index: 0,
    turn: state.opener,
    timerStartedAt: undefined,
    status: step === 'done' ? 'done' : state.status === 'waiting' ? 'waiting' : 'active',
  };
}

// ---- Partner phones' live states (invites) --------------------------------------------

interface Seen {
  memberId: string;
  state: TogetherLiveState;
  at: number;
}

let seen: Seen[] = [];
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const cb of [...listeners]) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onLive((memberId, state) => {
    seen = [...seen.filter((s) => s.memberId !== memberId), { memberId, state, at: Date.now() }];
    changed();
  });
}

/** A partner's session of `session` waiting to be joined (or still running), while fresh. */
export function useLiveInvite(session: TogetherSessionId | undefined, exceptSessionId?: string): Seen | undefined {
  listen();
  useSyncExternalStore(subscribe, () => version, () => version);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const invite = seen.find((s) =>
    (!session || s.state.session === session)
    && s.state.sessionId !== exceptSessionId
    && s.state.status !== 'done'
    && s.state.opener === s.memberId
    && now - s.at < INVITE_TTL_MS);
  useEffect(() => {
    if (!invite) return;
    const t = setTimeout(tick, Math.max(0, invite.at + INVITE_TTL_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [invite]);
  return invite;
}

/** For tests. */
export function resetLiveInvites(): void {
  seen = [];
  changed();
}

// ---- The run ---------------------------------------------------------------------------

export interface LiveRun {
  live: TogetherLiveState;
  steps: SessionStep[];
  /** Applies a change on this phone and tells the partner's phone (duo). */
  update(change: (state: TogetherLiveState) => TogetherLiveState): void;
  /** On to the next step. */
  next(): void;
}

/**
 * Holds a session's live state. In duo mode it sends every change to the partner's phone,
 * merges theirs, and repeats its own while waiting (and every few seconds while running, so a
 * phone that missed an event catches up).
 */
export function useLiveRun(initial: TogetherLiveState, opts: { duo: boolean; me: string }): LiveRun {
  const steps = sessionSteps(initial.session, initial.plan ?? {});
  const [live, setLive] = useState(initial);
  const liveRef = useRef(live);
  liveRef.current = live;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const send = useCallback((state: TogetherLiveState) => {
    if (!opts.duo) return;
    // The joiner never sends a plan of its own: only the opener's travels.
    sendLive(state.opener === opts.me ? state : { ...state, plan: undefined });
  }, [opts.duo, opts.me]);

  const update = useCallback((change: (state: TogetherLiveState) => TogetherLiveState) => {
    const next = change(liveRef.current);
    if (next === liveRef.current) return;
    liveRef.current = next;
    setLive(next);
    send(next);
  }, [send]);

  // On from the step this render showed, and only from there: a double tap, or a tap that lands
  // just after the partner's phone already moved on, never skips a step.
  const shownStep = live.step;
  const next = useCallback(
    () => update((s) => (s.step === shownStep ? nextStep(s, stepsRef.current) : s)),
    [update, shownStep],
  );

  useEffect(() => {
    if (!opts.duo) return;
    return onLive((memberId, state) => {
      if (memberId === opts.me || state.sessionId !== liveRef.current.sessionId) return;
      const merged = mergeLive(liveRef.current, state, stepsRef.current, memberId);
      if (merged === liveRef.current) return;
      const behind = comparePosition(stepsRef.current, state, merged) < 0 || state.status === 'waiting';
      liveRef.current = merged;
      setLive(merged);
      // Their phone is behind (or still waiting for us): say where we are.
      if (behind) send(merged);
    });
  }, [opts.duo, opts.me, send]);

  // Repeat our state: an invite while waiting, and a heartbeat while running.
  useEffect(() => {
    if (!opts.duo || live.status === 'done') return;
    send(liveRef.current);
    const t = setInterval(() => send(liveRef.current), LIVE_REPEAT_MS);
    return () => clearInterval(t);
  }, [opts.duo, live.status, live.step, send]);

  return { live, steps, update, next };
}
