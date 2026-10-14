// Keeping keyboard and screen-reader focus in the content when a step of a
// role-play or quiz replaces the button that had it.

import { useLayoutEffect, type RefObject } from 'react';

/** Focus fell back to the page: the control that had it was removed or switched off. */
export function focusLost(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el.tagName === 'MAIN' || !el.isConnected) return true;
  return (el as HTMLButtonElement).disabled === true;
}

/**
 * When `key` changes and focus fell back to the page, moves it to `ref` (made
 * focusable from script if it isn't already), so the next step is where a
 * keyboard or screen reader continues.
 */
export function useFocusWhenLost(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !focusLost()) return;
    if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.tabIndex = -1;
    el.focus();
  }, [ref, key]);
}
