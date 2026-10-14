// Live queries that can fail. useLiveQuery rethrows a querier's error during
// render, which would take the whole screen down; these hooks turn it into a
// state the screen can show (with a retry), and re-run whenever the Dexie
// tables the querier read change. Static data loaders may be awaited inside.

import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { dayKey } from '../../lib/db.ts';

export type Live<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: Error };

const LOADING = { status: 'loading' } as const;

export function useLive<T>(querier: () => Promise<T>, deps: readonly unknown[]): Live<T> & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const live = useLiveQuery(
    async (): Promise<Live<T>> => {
      try {
        return { status: 'ready', value: await querier() };
      } catch (e) {
        return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) };
      }
    },
    [...deps, attempt],
    LOADING as Live<T>,
  );
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...live, retry };
}

/**
 * A counter that changes when the app comes back to the foreground or the
 * study day rolls over, for queries that depend on the clock (what's due,
 * today's streak). An installed PWA can sit open in the background for days.
 */
export function useClockTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let day = dayKey();
    const bump = () => setTick((t) => t + 1);
    const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
    const timer = setInterval(() => {
      if (dayKey() !== day) {
        day = dayKey();
        bump();
      }
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return tick;
}

/** The value when ready, otherwise undefined. */
export function valueOf<T>(live: Live<T>): T | undefined {
  return live.status === 'ready' ? live.value : undefined;
}
