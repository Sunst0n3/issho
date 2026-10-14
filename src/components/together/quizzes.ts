// "Quiz each other": the latest inbox and sent quizzes, cached so the Together
// screen and an opened quiz still show offline, plus finished results waiting
// to be delivered when the home server couldn't be reached.

import { useEffect, useSyncExternalStore } from 'react';
import type { Quiz, QuizResultRequest, QuizzesResponse } from '../../../shared/api.ts';
import { getSettings } from '../../lib/db.ts';
import { ApiError, getQuizzes, isPairedSettings, submitQuizResult } from '../../sync/client.ts';
import { onServerEvent, onStatusChange } from '../../sync/socket.ts';
import { readJson, STORAGE_KEYS, writeJson } from './storage.ts';

export interface QuizzesState {
  data?: QuizzesResponse;
  /** When `data` came from the server (ms epoch). */
  fetchedAt?: number;
  loading: boolean;
  error?: ApiError;
}

interface PendingResult extends QuizResultRequest {
  id: string;
  finishedAt: string;
}

/** useQuizzes() refetches on mount when the lists are older than this. */
const STALE_MS = 30_000;

function readCache(): Pick<QuizzesState, 'data' | 'fetchedAt'> {
  const cached = readJson<{ data?: QuizzesResponse; fetchedAt?: number } | null>(STORAGE_KEYS.quizzes, null);
  const ok = cached?.data && Array.isArray(cached.data.inbox) && Array.isArray(cached.data.sent);
  return ok ? { data: cached.data, fetchedAt: cached.fetchedAt } : {};
}

let state: QuizzesState = { loading: false, ...readCache() };
const listeners = new Set<() => void>();

function setState(patch: Partial<QuizzesState>) {
  state = { ...state, ...patch };
  if (patch.data) writeJson(STORAGE_KEYS.quizzes, { data: state.data, fetchedAt: state.fetchedAt });
  for (const cb of [...listeners]) cb();
}

function pendingResults(): PendingResult[] {
  const list = readJson<unknown>(STORAGE_KEYS.quizResults, []);
  return Array.isArray(list) ? (list as PendingResult[]) : [];
}

function savePendingResults(list: PendingResult[]) {
  writeJson(STORAGE_KEYS.quizResults, list.length ? list : undefined);
}

/** Shows results that are still waiting to be sent as finished, so the quiz isn't offered again. */
function withPendingResults(data: QuizzesResponse): QuizzesResponse {
  const pending = new Map(pendingResults().map((p) => [p.id, p]));
  if (!pending.size) return data;
  return {
    ...data,
    inbox: data.inbox.map((q) => {
      const p = pending.get(q.id);
      return q.result || !p ? q : { ...q, result: { correct: p.correct, total: p.total, missed: p.missed, finishedAt: p.finishedAt } };
    }),
  };
}

function upsert(list: Quiz[], quiz: Quiz): Quiz[] {
  return list.some((q) => q.id === quiz.id) ? list.map((q) => (q.id === quiz.id ? quiz : q)) : [quiz, ...list];
}

/** Adds or replaces a quiz in the cached lists (a socket event or our own send). */
export async function rememberQuiz(quiz: Quiz): Promise<void> {
  const me = (await getSettings()).memberId;
  const data = state.data ?? { inbox: [], sent: [] };
  setState({
    data: withPendingResults({
      inbox: quiz.toMemberId === me ? upsert(data.inbox, quiz) : data.inbox,
      sent: quiz.fromMemberId === me ? upsert(data.sent, quiz) : data.sent,
    }),
  });
}

let flushing: Promise<void> | null = null;

/** Delivers finished results saved while offline, oldest first. */
export function flushQuizResults(): Promise<void> {
  flushing ??= (async () => {
    for (const p of pendingResults()) {
      try {
        const saved = await submitQuizResult(p.id, { correct: p.correct, total: p.total, missed: p.missed });
        savePendingResults(pendingResults().filter((x) => x.id !== p.id));
        await rememberQuiz(saved);
      } catch (e) {
        // A rejected result (say, the quiz is gone) will never go through; anything else waits for later.
        if (e instanceof ApiError && !e.transient && e.status !== 401 && e.code !== 'unpaired') {
          savePendingResults(pendingResults().filter((x) => x.id !== p.id));
          continue;
        }
        return;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

let request: Promise<void> | null = null;

/** Fetches both lists now (shared with a request already in flight). */
export function refreshQuizzes(): Promise<void> {
  request ??= (async () => {
    if (!isPairedSettings(await getSettings())) return;
    setState({ loading: true });
    try {
      await flushQuizResults();
      const data = withPendingResults(await getQuizzes());
      setState({ data, fetchedAt: Date.now(), loading: false, error: undefined });
    } catch (e) {
      setState({ loading: false, error: e instanceof ApiError ? e : new ApiError(0, 'network', String(e)) });
    }
  })().finally(() => { request = null; });
  return request;
}

/**
 * Records a finished quiz and sends the score. Resolves 'queued' when the server
 * can't be reached; the score goes out with the next refresh or reconnect.
 */
export async function finishQuiz(quiz: Quiz, result: QuizResultRequest): Promise<'sent' | 'queued'> {
  const finishedAt = new Date().toISOString();
  await rememberQuiz({ ...quiz, result: { ...result, finishedAt } });
  try {
    await rememberQuiz(await submitQuizResult(quiz.id, result));
    return 'sent';
  } catch (e) {
    if (e instanceof ApiError && !e.transient && e.status !== 401 && e.code !== 'unpaired') throw e;
    savePendingResults([...pendingResults().filter((p) => p.id !== quiz.id), { id: quiz.id, ...result, finishedAt }]);
    return 'queued';
  }
}

export function findQuiz(id: string): Quiz | undefined {
  return state.data?.inbox.find((q) => q.id === id) ?? state.data?.sent.find((q) => q.id === id);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const snapshot = () => state;

/** The quiz lists (cached copy offline), refreshed on mount when stale and live on 'quiz' events. */
export function useQuizzes(): QuizzesState & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!state.fetchedAt || Date.now() - state.fetchedAt > STALE_MS) void refreshQuizzes();
  }, []);
  return { ...current, refresh: refreshQuizzes };
}

/** For tests: forget everything held in memory. */
export function resetQuizzes(): void {
  state = { loading: false, ...readCache() };
  for (const cb of [...listeners]) cb();
}

onServerEvent((ev) => {
  if (ev.type === 'quiz') void rememberQuiz(ev.quiz);
});
onStatusChange((s) => {
  if (s !== 'online') return;
  if (listeners.size) void refreshQuizzes();
  else void flushQuizResults();
});
