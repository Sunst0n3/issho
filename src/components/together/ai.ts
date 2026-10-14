// Whether the home server has the AI helper turned on, asked once per session,
// and friendly wording for the helper's errors.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, health } from '../../sync/client.ts';

/**
 * The helper is switched on but failing on the server's side: a key or model the
 * API refuses ('ai_misconfigured'), or the API itself erroring ('ai_unavailable').
 */
export type AiProblem = 'ai_misconfigured' | 'ai_unavailable';

/**
 * Shown once, in the chat, when the helper turns out to be broken. Only a refused key
 * or model points at the server's setup; an erroring API is nothing to fix at home.
 */
export const AI_BROKEN_NOTICE: Record<AiProblem, string> = {
  ai_misconfigured: "The AI helper isn't working — check the server's API key.",
  ai_unavailable: "The AI helper isn't answering right now, so messages send without a check.",
};

let known: Promise<boolean> | null = null;
let problem: AiProblem | undefined;
/** Bumps whenever the session's verdict changes, so mounted screens re-ask. */
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

/** Resolves false when the helper is off or the server can't be asked right now. */
export function aiAvailable(): Promise<boolean> {
  if (!known) {
    const asking = health().then((h) => h.aiEnabled === true);
    known = asking;
    // Only a real answer is remembered; an unreachable server is asked again next time.
    asking.catch(() => { if (known === asking) known = null; });
  }
  return known.catch(() => false);
}

/** The server said 'ai_disabled' after all: hide the helper for the rest of the session. */
export function markAiDisabled(): void {
  known = Promise.resolve(false);
  changed();
}

/** The helper's failure when it is a server-side problem that won't fix itself, else undefined. */
export function aiProblemOf(e: unknown): AiProblem | undefined {
  const code = e instanceof ApiError ? e.code : undefined;
  return code === 'ai_misconfigured' || code === 'ai_unavailable' ? code : undefined;
}

/**
 * The helper failed on the server's side: stop asking it for the rest of the session
 * (messages go without a check), and remember why so Settings can say so.
 */
export function markAiBroken(why: AiProblem): void {
  problem ??= why;
  known = Promise.resolve(false);
  changed();
}

/** Why the helper isn't working this session, if it failed on the server's side. */
export function aiProblem(): AiProblem | undefined {
  return problem;
}

/** aiProblem(), kept current (for Settings → AI helper). */
export function useAiProblem(): AiProblem | undefined {
  return useSyncExternalStore(subscribe, aiProblem, aiProblem);
}

/** For tests. */
export function resetAiAvailability(): void {
  known = null;
  problem = undefined;
  changed();
}

/**
 * True once the server has confirmed the helper is on. Re-asks when `reachable` turns
 * true, and turns false as soon as the helper is found to be off or broken.
 */
export function useAiAvailable(reachable: boolean): boolean {
  const [on, setOn] = useState(false);
  const verdict = useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (!reachable) return;
    let live = true;
    void aiAvailable().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, [reachable, verdict]);
  return on;
}

export const TIMED_OUT = Symbol('timed out');

/** Resolves with TIMED_OUT if `p` hasn't settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function aiErrorMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'network':
    case 'timeout':
    case 'unpaired':
      return typeof navigator !== 'undefined' && navigator.onLine === false
        ? "You're offline. The helper needs your home server."
        : "Couldn't reach your home server. Try again in a moment.";
    case 'ai_rate_limited':
    case 'rate_limited':
      return 'The helper needs a short break. Try again in a minute.';
    case 'refused':
      return "The helper can't help with that one. Try saying it another way.";
    case 'ai_misconfigured':
      return "The helper isn't set up right on the home server.";
    case 'ai_disabled':
      return "The helper isn't turned on for your home server.";
    default:
      return "The helper isn't answering right now. Try again in a moment.";
  }
}
