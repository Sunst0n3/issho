import { useCallback, useEffect, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  retry: () => void;
}

/** Runs an async loader whenever `deps` change; stale results are dropped. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });

  useEffect(() => {
    let live = true;
    setState((s) => (s.loading && !s.error && s.data === undefined ? s : { loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e : new Error(String(e)), loading: false }),
    );
    return () => {
      live = false;
    };
    // The caller's deps decide when to reload.
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
