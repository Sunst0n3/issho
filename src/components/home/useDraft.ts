import { useEffect, useRef, useState } from 'react';

/**
 * Local state for a control bound to a live setting. Changes show at once and
 * are saved after a short pause, so dragging a slider or tapping + quickly never
 * fights with the database echoing back older values. Outside changes (a backup
 * restore) still come through when nothing is waiting to be saved.
 *
 * `same(saved, draft)`: the saved value is what saving `draft` stores. A save that
 * tidies the value (trims it, rebuilds a sentence) then echoes back without
 * replacing the draft, so a space typed before a pause isn't lost.
 */
export function useDraft<T>(
  value: T,
  save: (value: T) => unknown,
  delayMs = 250,
  same?: (saved: T, draft: T) => boolean,
): [T, (value: T) => void] {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saveRef = useRef(save);
  saveRef.current = save;
  const sameRef = useRef(same);
  sameRef.current = same;

  useEffect(() => {
    if (!pending.current) setDraft((current) => (sameRef.current?.(value, current) ? current : value));
  }, [value]);

  // Leaving the screen saves whatever is still waiting.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (pending.current) void saveRef.current(pending.current.value);
  }, []);

  const set = (next: T) => {
    setDraft(next);
    pending.current = { value: next };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      void saveRef.current(next);
    }, delayMs);
  };
  return [draft, set];
}
