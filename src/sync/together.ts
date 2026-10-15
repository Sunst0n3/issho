// The together routine's sync: events (slots, goal, session-done, smooth, …) queued offline
// and posted in order, the household's together state cached for offline use, live session
// state relayed between the two phones, and the side effects other phones' work has here:
//
// - a together session in the state (dated today or yesterday) credits this member's day,
//   whichever phone ran it (creditTogetherSession is idempotent, so repeats are harmless);
// - a partner quiz this phone answered gets its verdicts applied to the FSRS cards once the
//   asker posts them (applyPartnerVerdicts applies each quiz once);
// - output-step checks that were queued offline are revealed when the server is reachable.

import { useEffect, useSyncExternalStore } from 'react';
import type { Table } from 'dexie';
import type { Quiz, TogetherEvent, TogetherLiveState, TogetherState } from '../../shared/api.ts';
import { db, dayKey, getSettings } from '../lib/db.ts';
import { rubyToPlain } from '../lib/ruby.ts';
import type { TogetherOutboxRecord } from '../lib/types.ts';
import { addDays, weekStart } from '../srs/days.ts';
import { creditTogetherSession } from '../srs/habits.ts';
import { completeOutputCheck, learnerAiContext, pendingOutputChecks } from '../srs/output.ts';
import { applyPartnerVerdicts } from '../srs/together.ts';
import { aiCheck, ApiError, getQuizzes, getTogether, isPairedSettings, postTogetherEventRaw } from './client.ts';
import { uuid } from './outbox.ts';
import { onServerEvent, onStatusChange, sendClientEvent } from './socket.ts';

/** useTogetherState() refetches on mount when the state is older than this. */
const STALE_MS = 60_000;
const CACHE_KEY = 'issho.together.v1';
const RETRY_INTERVAL_MS = 30_000;
/** Quiz kinds whose verdicts this phone (the answerer) applies to its own cards. */
const VERDICT_KINDS: ReadonlySet<Quiz['kind']> = new Set(['partner', 'dictation', 'monthly']);

const outbox = () => db.togetherOutbox as Table<TogetherOutboxRecord, string>;

// ---- Outbox ------------------------------------------------------------------

let lastQueuedAt = 0;

/** Queues the event in togetherOutbox (uuid clientId, ISO week of `now`) and flushes when online; resolves once queued. */
export async function postTogetherEvent(event: TogetherEvent, now: Date = new Date()): Promise<void> {
  // Rows go out in createdAt order, so two events queued in the same millisecond keep their order.
  lastQueuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  await outbox().add({
    clientId: uuid(),
    createdAt: new Date(lastQueuedAt),
    week: weekStart(dayKey(now)),
    event: JSON.stringify(event),
    attempts: 0,
  });
  void flushTogetherOutbox();
}

async function flushOnce(): Promise<{ sent: number; blocked: boolean; remaining: number }> {
  const waiting = () => outbox().filter((r) => !r.failed).count();
  if (!isPairedSettings(await getSettings())) return { sent: 0, blocked: true, remaining: await waiting() };
  let sent = 0;
  for (const row of await outbox().orderBy('createdAt').toArray()) {
    if (row.failed) continue;
    let event: TogetherEvent;
    try {
      event = JSON.parse(row.event) as TogetherEvent;
    } catch {
      await outbox().update(row.clientId, { failed: 'bad_event' });
      continue;
    }
    try {
      const state = await postTogetherEventRaw({ clientId: row.clientId, week: row.week, event });
      await outbox().delete(row.clientId);
      sent++;
      setState({ state, fetchedAt: Date.now(), offline: false });
      void creditRecentSessions(state);
    } catch (e) {
      const permanent = e instanceof ApiError && !e.transient
        && e.status !== 401 && e.status !== 403 && e.code !== 'unpaired';
      await outbox().update(row.clientId, {
        attempts: row.attempts + 1,
        ...(permanent ? { failed: (e as ApiError).code } : {}),
      });
      // A refused event is skipped; anything else means the server is unreachable, so keep the order.
      if (permanent) continue;
      return { sent, blocked: true, remaining: await waiting() };
    }
  }
  return { sent, blocked: false, remaining: await waiting() };
}

let flushing: Promise<number> | null = null;
let flushAgain = false;
let syncActive = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Posts queued together events in order (idempotent on the server by clientId). Resolves with how many were sent. */
export function flushTogetherOutbox(): Promise<number> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushAgain = false;
  flushing = flushOnce()
    .catch((e: unknown) => {
      console.error('together outbox flush failed', e);
      return { sent: 0, blocked: true, remaining: -1 };
    })
    .then(async (result) => {
      flushing = null;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (flushAgain && !result.blocked) return result.sent + (await flushTogetherOutbox());
      if (syncActive && result.remaining !== 0) retryTimer = setTimeout(() => void flushTogetherOutbox(), RETRY_INTERVAL_MS);
      return result.sent;
    });
  return flushing;
}

// ---- State -----------------------------------------------------------------------

interface TogetherStore {
  state: TogetherState | null;
  /** When `state` was fetched (ms epoch). */
  fetchedAt?: number;
  /** The last refresh could not reach the server (or the phone is not paired): `state` is the cached copy. */
  offline: boolean;
}

function readCache(): TogetherStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { state?: TogetherState; fetchedAt?: number } | null;
    if (parsed?.state && Array.isArray(parsed.state.sessions) && Array.isArray(parsed.state.slots)) {
      return { state: parsed.state, fetchedAt: parsed.fetchedAt, offline: false };
    }
  } catch {
    // Unreadable cache: start empty.
  }
  return { state: null, offline: false };
}

function writeCache(state: TogetherState | null, fetchedAt?: number): void {
  try {
    if (state) localStorage.setItem(CACHE_KEY, JSON.stringify({ state, fetchedAt }));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage unavailable (private mode): the state just won't survive a reload.
  }
}

let store: TogetherStore = readCache();
const listeners = new Set<() => void>();

function setState(patch: Partial<TogetherStore>): void {
  store = { ...store, ...patch };
  if (patch.state !== undefined) writeCache(store.state, store.fetchedAt);
  for (const cb of [...listeners]) cb();
}

let refreshing: Promise<void> | null = null;

/** Fetches GET /api/together now (shared with a fetch already in flight), then credits recent sessions. */
export function refreshTogether(): Promise<void> {
  refreshing ??= (async () => {
    if (!isPairedSettings(await getSettings())) {
      setState({ offline: true });
      return;
    }
    try {
      const state = await getTogether();
      setState({ state, fetchedAt: Date.now(), offline: false });
      await creditRecentSessions(state);
    } catch (e) {
      if (!(e instanceof ApiError && e.transient)) console.warn('could not load the together state', e);
      setState({ offline: true });
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

let refreshQueued: Promise<void> | null = null;

/**
 * The server announced a change ('together'): a fetch already in flight may have been answered
 * before it (and would then overwrite newer state), so fetch once more after that one. Calls
 * arriving meanwhile share the queued fetch.
 */
function refreshAfterChange(): Promise<void> {
  if (!refreshing) return refreshTogether();
  refreshQueued ??= refreshing.catch(() => {}).then(() => {
    refreshQueued = null;
    // A refresh started since then left after the change: sharing it is enough.
    return refreshing ?? refreshTogether();
  });
  return refreshQueued;
}

/** Forgets the cached state (after unpairing or pairing with another household). */
export function resetTogether(): void {
  setState({ state: null, fetchedAt: undefined, offline: false });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const snapshot = () => store;

/** Cached state (localStorage 'issho.together.v1'), refreshed on mount when older than 60 s and on 'together' events. */
export function useTogetherState(): { state: TogetherState | null; offline: boolean; refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!store.fetchedAt || Date.now() - store.fetchedAt > STALE_MS) void refreshTogether();
  }, []);
  return { state: current.state, offline: current.offline, refresh: refreshTogether };
}

// ---- Side effects of the state, quizzes and checks ------------------------------------

/** Credits every together session dated today or yesterday (once per session and date; B dedupes too). */
async function creditRecentSessions(state: TogetherState, now: Date = new Date()): Promise<void> {
  const today = dayKey(now);
  const recent = new Set([today, addDays(today, -1)]);
  const seen = new Set<string>();
  for (const s of state.sessions) {
    const key = `${s.session}|${s.date}`;
    if (!recent.has(s.date) || seen.has(key)) continue;
    seen.add(key);
    try {
      await creditTogetherSession(s.session, s.minutes, s.date, now);
    } catch (e) {
      console.error('could not credit the together session', e);
    }
  }
}

/** Quiz ids being applied right now: a WebSocket event and a refresh can deliver the same quiz at once. */
const applying = new Map<string, Promise<boolean>>();

/** This phone answered the quiz and the asker has posted the verdicts. */
function answeredHere(quiz: Quiz, me: string | undefined): boolean {
  return Boolean(me) && quiz.fromMemberId === me && VERDICT_KINDS.has(quiz.kind) && Boolean(quiz.result?.verdicts?.length);
}

/** Applies the asker's verdicts when this phone answered the quiz (applied once per quiz, in B). True when applied now. */
function applyQuizResult(quiz: Quiz, me: string | undefined): Promise<boolean> {
  if (!answeredHere(quiz, me)) return Promise.resolve(false);
  const pending = applying.get(quiz.id);
  if (pending) return pending.then(() => false);
  const run = (async () => {
    try {
      if ((await db.partnerQuizzes.get(quiz.id))?.appliedAt) return false;
      await applyPartnerVerdicts(quiz);
      return true;
    } catch (e) {
      console.error('could not apply the partner quiz verdicts', e);
      return false;
    } finally {
      applying.delete(quiz.id);
    }
  })();
  applying.set(quiz.id, run);
  return run;
}

/** Applies the verdicts of every finished quiz this phone answered (catch-up after being offline). Resolves with how many were applied now. */
export async function syncPartnerQuizzes(): Promise<number> {
  const settings = await getSettings();
  if (!isPairedSettings(settings)) return 0;
  let quizzes: Quiz[];
  try {
    const { inbox, sent } = await getQuizzes();
    quizzes = [...sent, ...inbox];
  } catch {
    return 0;
  }
  let applied = 0;
  for (const quiz of quizzes) {
    if (await applyQuizResult(quiz, settings.memberId)) applied++;
  }
  return applied;
}

let checking: Promise<number> | null = null;

/** Retries B's pendingOutputChecks with aiCheck({ mode: 'reveal' }) when the server is reachable. */
export function flushPendingOutputChecks(): Promise<number> {
  checking ??= (async () => {
    if (!isPairedSettings(await getSettings())) return 0;
    let pending: Awaited<ReturnType<typeof pendingOutputChecks>>;
    let context: Awaited<ReturnType<typeof learnerAiContext>>;
    try {
      pending = await pendingOutputChecks();
      if (!pending.length) return 0;
      context = await learnerAiContext();
    } catch (e) {
      console.error('could not read the pending output checks', e);
      return 0;
    }
    let done = 0;
    for (const rec of pending) {
      try {
        const result = await aiCheck({
          ...context,
          text: rec.text,
          mode: 'reveal',
          target: rubyToPlain(rec.target.label),
          ...(rec.draft && rec.draft !== rec.text ? { firstAttempt: rec.draft } : {}),
        });
        await completeOutputCheck(rec.id, result);
        done++;
      } catch (e) {
        // A request the server refuses for good is skipped; anything else (offline, AI off, rate
        // limited) waits for the next time the server is reachable.
        if (e instanceof ApiError && !e.transient && e.code !== 'ai_disabled' && e.status !== 401 && e.status !== 403) continue;
        if (!(e instanceof ApiError)) console.error('could not complete the output check', e);
        break;
      }
    }
    return done;
  })().finally(() => { checking = null; });
  return checking;
}

// ---- Live session state ----------------------------------------------------------------

type LiveListener = (memberId: string, state: TogetherLiveState) => void;
const liveListeners = new Set<LiveListener>();

/** Sends this phone's live session state to the partner. False when the socket is not open. */
export function sendLive(state: TogetherLiveState): boolean {
  return sendClientEvent({ type: 'live', state });
}

/** Calls `cb` with every live state the partner's phone sends. Returns an unsubscribe function. */
export function onLive(cb: LiveListener): () => void {
  liveListeners.add(cb);
  return () => { liveListeners.delete(cb); };
}

// ---- Start-up -------------------------------------------------------------------------

/** Everything worth doing when the server becomes reachable. */
async function catchUp(): Promise<void> {
  await flushTogetherOutbox();
  await Promise.all([refreshTogether(), syncPartnerQuizzes(), flushPendingOutputChecks()]);
}

/** Starts: outbox flush on reconnect; 'together' (and every refresh) → refresh, then creditTogetherSession(session,
 *  minutes, date) for every state.sessions entry dated today or yesterday (idempotent in B, so repeats are harmless; a
 *  together session counts for both members whoever posted it); 'quiz' with a result where fromMemberId === me and kind
 *  partner/dictation/monthly → applyPartnerVerdicts (applied once in B); pending output checks → reveal + completeOutputCheck. */
export function startTogetherSync(): () => void {
  if (syncActive) return () => {};
  syncActive = true;

  const offEvents = onServerEvent((ev) => {
    if (ev.type === 'together') {
      void refreshAfterChange();
    } else if (ev.type === 'quiz') {
      void getSettings().then((s) => applyQuizResult(ev.quiz, s.memberId));
    } else if (ev.type === 'live') {
      for (const cb of [...liveListeners]) {
        try { cb(ev.memberId, ev.state); } catch (e) { console.error('live listener failed', e); }
      }
    }
  });
  const offStatus = onStatusChange((s) => {
    if (s === 'online') void catchUp();
  });
  const onOnline = () => void flushTogetherOutbox();
  window.addEventListener('online', onOnline);
  void catchUp();

  return () => {
    syncActive = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    offEvents();
    offStatus();
    window.removeEventListener('online', onOnline);
  };
}
