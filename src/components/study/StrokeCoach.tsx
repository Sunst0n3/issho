// The live feedback line under a writing pad ("Stroke 2 looks good / Next: …")
// and the Undo / Hint / Clear buttons that drive the pad.

import { useCallback, useRef, useState, type RefObject } from 'react';
import { describeStroke, mistakeMessage } from '../../writing/describe.ts';
import type { StrokeAttempt } from '../../writing/matcher.ts';
import { AUTO_HINT_AFTER, type WritingMode, type WritingPadHandle } from '../../writing/WritingPad.tsx';
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
 * Where the pad is, mirrored from its callbacks and the buttons: strokes
 * accepted, misses on the stroke now expected, and whether its hint is showing
 * (Hint, or automatically after AUTO_HINT_AFTER misses, as the pad does).
 */
interface PadPosition {
  done: number;
  tries: number;
  hinted: boolean;
}

const START: PadPosition = { done: 0, tries: 0, hinted: false };

export interface StrokeCoach {
  line: CoachLine;
  setLine: (line: CoachLine) => void;
  /** Back to the opening line (Clear, or a fresh attempt). */
  reset: () => void;
  onStrokeResult: (index: number, ok: boolean, detail: StrokeAttempt) => void;
  /** The pad's last stroke was undone. */
  onUndo: () => void;
  /** The pad is showing the next stroke as a hint. */
  onHint: () => void;
}

/**
 * Feedback for each checked stroke, kept in step with Undo and Hint. Directions
 * for the next stroke are left out in memory mode, where they would give the
 * answer away (a hint shows the stroke anyway, so it is described then).
 */
export function useStrokeCoach(strokes: readonly string[], mode: WritingMode): StrokeCoach {
  // A new character or mode starts over with its opening line.
  const key = `${mode}:${strokes.join('|')}`;
  const [state, setState] = useState(() => ({ key, line: opening(strokes, mode) }));
  const position = useRef<PadPosition & { key: string }>({ ...START, key });
  if (position.current.key !== key) position.current = { ...START, key };
  if (state.key !== key) setState({ key, line: opening(strokes, mode) });

  const setLine = useCallback((line: CoachLine) => setState({ key, line }), [key]);
  const reset = useCallback(() => {
    position.current = { ...START, key };
    setState({ key, line: opening(strokes, mode) });
  }, [key, strokes, mode]);

  const onStrokeResult = useCallback((index: number, ok: boolean, detail: StrokeAttempt) => {
    const at = position.current;
    if (!ok) {
      at.tries++;
      at.hinted ||= at.tries >= AUTO_HINT_AFTER;
      setLine({ head: mistakeMessage(detail, index, at.hinted), tone: 'bad' });
      return;
    }
    Object.assign(at, { done: index + 1, tries: 0, hinted: false });
    const following = strokes[index + 1];
    setLine({
      head: following ? `Stroke ${index + 1} looks good.` : 'All strokes done.',
      next: following && mode !== 'memory' ? `Next: ${describeStroke(following)}.` : undefined,
      tone: 'good',
    });
  }, [strokes, mode, setLine]);

  const onUndo = useCallback(() => {
    const at = position.current;
    if (at.done === 0) return; // nothing to undo: the pad ignores it too
    Object.assign(at, { done: at.done - 1, tries: 0, hinted: false });
    if (at.done === 0) {
      setLine(opening(strokes, mode));
      return;
    }
    const expected = strokes[at.done];
    setLine({
      head: `Back to stroke ${at.done + 1} of ${strokes.length}.`,
      next: expected && mode !== 'memory' ? `Next: ${describeStroke(expected)}.` : undefined,
      tone: 'info',
    });
  }, [strokes, mode, setLine]);

  const onHint = useCallback(() => {
    const at = position.current;
    const expected = strokes[at.done];
    if (!expected) return;
    at.hinted = true;
    setLine({ head: `Here is stroke ${at.done + 1}.`, next: `${capitalize(describeStroke(expected))}.`, tone: 'info' });
  }, [strokes, setLine]);

  return { line: state.key === key ? state.line : opening(strokes, mode), setLine, reset, onStrokeResult, onUndo, onHint };
}

export function CoachText({ line }: { line: CoachLine }) {
  return (
    <div className={`st-coach ${line.tone}`} aria-live="polite">
      <p className="st-coach-head">{line.head}</p>
      {line.next && <p className="st-coach-next">{line.next}</p>}
    </div>
  );
}

/** Undo / Hint / and Clear or Give up, as three equal buttons. They keep `coach` in step with the pad. */
export function PadTools({ pad, coach, onClear, last = 'clear', disabled = false }: {
  pad: RefObject<WritingPadHandle | null>;
  coach?: Pick<StrokeCoach, 'onUndo' | 'onHint'>;
  onClear?: () => void;
  last?: 'clear' | 'giveUp';
  disabled?: boolean;
}) {
  return (
    <div className="st-padtools">
      <button type="button" className="btn secondary small" disabled={disabled}
        onClick={() => { pad.current?.undo(); coach?.onUndo(); }}>
        <Icon name="undo" size={18} />Undo
      </button>
      <button type="button" className="btn secondary small" disabled={disabled}
        onClick={() => { pad.current?.hint(); coach?.onHint(); }}>
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
