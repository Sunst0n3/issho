// Multiple choice as a capped hint: typed cards show no options until the learner asks ("Show options"), and a pick
// is graded at most Hard. Hands-busy mode shows them at once.

import { useState, type ReactNode } from 'react';
import { ChoiceGrid } from './parts.tsx';

export function ShowOptions({ options, answer, lang, open: openAtStart = false, focusOnShow = false, render, onOpen, onPick }: {
  options: readonly string[];
  answer: string;
  lang?: 'ja';
  /** Shown at once (hands-busy mode, or after the link gave way to the choices). */
  open?: boolean;
  /** The choices replace the link that had focus: focus moves to them. */
  focusOnShow?: boolean;
  /** How a choice reads on its button (e.g. with furigana). */
  render?: (option: string) => ReactNode;
  /** The link was tapped: the typed field gives way to the choices. */
  onOpen?: () => void;
  onPick: (correct: boolean) => void;
}) {
  const [open, setOpen] = useState(openAtStart);
  const [picked, setPicked] = useState<string | null>(null);
  if (options.length < 2) return null;
  if (!open) {
    return (
      <button type="button" className="btn ghost small st-mode-toggle" onClick={() => { setOpen(true); onOpen?.(); }}>
        Show options
      </button>
    );
  }
  return (
    <ChoiceGrid options={options} answer={answer} picked={picked} lang={lang} render={render} focusOnShow={focusOnShow || !openAtStart}
      onPick={(option) => {
        if (picked !== null) return;
        setPicked(option);
        onPick(option === answer);
      }} />
  );
}
