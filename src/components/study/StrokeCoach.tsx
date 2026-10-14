// The live feedback line under a writing pad ("Stroke 2 looks good / Next: …")
// and the Undo / Hint / Clear buttons that drive the pad.

import { useCallback, useState, type RefObject } from 'react';
import { describeStroke, mistakeMessage } from '../../writing/describe.ts';
import type { StrokeAttempt } from '../../writing/matcher.ts';
import type { WritingMode, WritingPadHandle } from '../../writing/WritingPad.tsx';
import { Icon } from '../ui.tsx';

export interface CoachLine {
  head: string;
  next?: string;
  tone: 'info' | 'good' | 'bad';
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function opening(strokes: readonly string[], mode: WritingMode): CoachLine {
  const n = strokes.length;
  const count = `${n} ${n === 1 ? 'stroke' : 'strokes'}`;
  if (mode === 'memory') return { head: `From memory: ${count}.`, next: 'Ask for a hint if you get stuck.', tone: 'info' };
  const first = strokes[0] ? `${capitalize(describeStroke(strokes[0]))}.` : undefined;
  return mode === 'trace'
    ? { head: `Trace over the grey character: ${count}.`, next: first && `First: ${first}`, tone: 'info' }
    : { head: `Start at the dot: ${count}.`, next: first && `First: ${first}`, tone: 'info' };
}

/**
 * Feedback for each checked stroke. Directions for the next stroke are left
 * out in memory mode, where they would give the answer away.
 */
export function useStrokeCoach(strokes: readonly string[], mode: WritingMode) {
  // A new character or mode starts over with its opening line.
  const key = `${mode}:${strokes.join('|')}`;
  const [state, setState] = useState(() => ({ key, line: opening(strokes, mode) }));
  if (state.key !== key) setState({ key, line: opening(strokes, mode) });

  const setLine = useCallback((line: CoachLine) => setState({ key, line }), [key]);
  const reset = useCallback(() => setState({ key, line: opening(strokes, mode) }), [key, strokes, mode]);

  const onStrokeResult = useCallback((index: number, ok: boolean, detail: StrokeAttempt) => {
    if (!ok) {
      setLine({ head: mistakeMessage(detail, index), tone: 'bad' });
      return;
    }
    const following = strokes[index + 1];
    setLine({
      head: following ? `Stroke ${index + 1} looks good.` : 'All strokes done.',
      next: following && mode !== 'memory' ? `Next: ${describeStroke(following)}.` : undefined,
      tone: 'good',
    });
  }, [strokes, mode, setLine]);

  return { line: state.key === key ? state.line : opening(strokes, mode), setLine, reset, onStrokeResult };
}

export function CoachText({ line }: { line: CoachLine }) {
  return (
    <div className={`st-coach ${line.tone}`} aria-live="polite">
      <p className="st-coach-head">{line.head}</p>
      {line.next && <p className="st-coach-next">{line.next}</p>}
    </div>
  );
}

/** Undo / Hint / and Clear or Give up, as three equal buttons. */
export function PadTools({ pad, onClear, last = 'clear', disabled = false }: {
  pad: RefObject<WritingPadHandle | null>;
  onClear?: () => void;
  last?: 'clear' | 'giveUp';
  disabled?: boolean;
}) {
  return (
    <div className="st-padtools">
      <button type="button" className="btn secondary small" disabled={disabled} onClick={() => pad.current?.undo()}>
        <Icon name="undo" size={18} />Undo
      </button>
      <button type="button" className="btn secondary small" disabled={disabled} onClick={() => pad.current?.hint()}>
        <Icon name="bulb" size={18} />Hint
      </button>
      {last === 'clear' ? (
        <button type="button" className="btn secondary small" disabled={disabled}
          onClick={() => { pad.current?.clear(); onClear?.(); }}>
          <Icon name="trash" size={18} />Clear
        </button>
      ) : (
        <button type="button" className="btn secondary small" disabled={disabled} onClick={() => pad.current?.giveUp()}>
          <Icon name="eye" size={18} />Give up
        </button>
      )}
    </div>
  );
}
