// Whether the home server has the AI helper turned on, asked once per session,
// and friendly wording for the helper's errors.

import { useEffect, useState } from 'react';
import { ApiError, health } from '../../sync/client.ts';

let known: Promise<boolean> | null = null;

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
}

/** For tests. */
export function resetAiAvailability(): void {
  known = null;
}

/** True once the server has confirmed the helper is on. Re-asks when `reachable` turns true. */
export function useAiAvailable(reachable: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!reachable) return;
    let live = true;
    void aiAvailable().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, [reachable]);
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
