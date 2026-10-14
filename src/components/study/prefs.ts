// Per-device conveniences for the study screens, kept in localStorage.
// Storage can be missing or blocked (private mode), so every access is guarded.

import { useState } from 'react';

const TYPED_KEY = 'issho.study.typed';

function readTyped(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(TYPED_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Whether the learner prefers typing answers for this kind of card (default: choices). */
export function useTypedPreference(view: string): [boolean, (typed: boolean) => void] {
  const [typed, setTyped] = useState(() => readTyped()[view] === true);
  const update = (next: boolean) => {
    setTyped(next);
    try {
      localStorage.setItem(TYPED_KEY, JSON.stringify({ ...readTyped(), [view]: next }));
    } catch {
      // Not remembered on this device; the toggle still works for now.
    }
  };
  return [typed, update];
}
