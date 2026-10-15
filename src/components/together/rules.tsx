// The together ground rules, shown in full at the start of the first three sessions and folded
// away after that.

import { useEffect, useRef, useState } from 'react';
import { readJson, STORAGE_KEYS, writeJson } from './storage.ts';

export const RULES_SHOWN_TIMES = 3;

export const TOGETHER_RULES = [
  { jp: 'もう一度？', text: 'One signal when you’re lost: もう一度？ and point at the word.' },
  { text: 'No explaining grammar to each other. Just keep talking.' },
  { text: 'Turns alternate. Let your partner finish.' },
  { text: 'Corrections come from the AI, privately, on your own phone.' },
] as const;

function timesShown(): number {
  const n = readJson<unknown>(STORAGE_KEYS.rulesShown, 0);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function TogetherRules() {
  // Decided once per session screen, so the card doesn't fold up while it is being read.
  const [open] = useState(() => timesShown() < RULES_SHOWN_TIMES);
  const counted = useRef(false);
  useEffect(() => {
    if (counted.current) return;
    counted.current = true;
    writeJson(STORAGE_KEYS.rulesShown, timesShown() + 1);
  }, []);

  return (
    <details className="card tg-rules" open={open}>
      <summary className="label">Together rules</summary>
      <ul className="tg-rules-list">
        {TOGETHER_RULES.map((r) => <li key={r.text}>{r.text}</li>)}
      </ul>
    </details>
  );
}
