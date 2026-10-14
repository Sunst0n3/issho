// Writing a new character three times: trace, guided (start dot only), then
// from memory. Each pass moves on by itself after a short "Nice".

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StrokeOrderStrip } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { WritingPad, type WritingMode, type WritingPadHandle, type WritingResult } from '../../../writing/WritingPad.tsx';
import { Icon } from '../../ui.tsx';
import { CoachText, PadTools, useStrokeCoach } from '../StrokeCoach.tsx';

export const ALL_PASSES: WritingMode[] = ['trace', 'guided', 'memory'];
const PASS_NAMES: Record<WritingMode, string> = { trace: 'Trace', guided: 'Guided', memory: 'Memory' };
const NEXT_PASS: Record<WritingMode, string> = {
  trace: 'trace it',
  guided: 'write it with just the start dots',
  memory: 'write it from memory',
};
/** How long the "Nice" state shows before the next pass. */
export const NICE_MS = 900;

const NO_STROKES: string[] = [];

function PassSteps({ passes, at, done }: { passes: readonly WritingMode[]; at: number; done: boolean }) {
  if (passes.length < 2) return null;
  return (
    <ol className="st-passes" aria-label="Writing steps">
      {passes.map((pass, i) => {
        const state = i < at || done ? 'done' : i === at ? 'current' : '';
        return (
          <li key={pass} className={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="st-pass-dot" aria-hidden="true">{state === 'done' ? <Icon name="check" size={14} strokeWidth={3} /> : i + 1}</span>
            {PASS_NAMES[pass]}
            {state === 'done' && <span className="visually-hidden"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function WriteSteps({ char, passes = ALL_PASSES, ask, target, onDone, onSkip }: {
  char: string;
  passes?: readonly WritingMode[];
  ask: string;
  target: ReactNode;
  onDone: () => void;
  onSkip: () => void;
}) {
  const { strokes, loading, missing, error } = useStrokes(char);
  const pad = useRef<WritingPadHandle>(null);
  const [at, setAt] = useState(0);
  const [status, setStatus] = useState<'writing' | 'nice' | 'done'>('writing');
  const mode = passes[at];
  const coach = useStrokeCoach(strokes ?? NO_STROKES, mode);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const complete = (result: WritingResult) => {
    const last = at === passes.length - 1;
    if (!last) {
      setStatus('nice');
      coach.setLine({ head: 'Nice.', next: `Now ${NEXT_PASS[passes[at + 1]]}.`, tone: 'good' });
      timer.current = setTimeout(() => {
        setAt(at + 1);
        setStatus('writing');
      }, NICE_MS);
      return;
    }
    setStatus('done');
    const clean = !result.gaveUp && result.mistakes === 0 && result.hintsUsed === 0;
    coach.setLine(clean
      ? { head: mode === 'memory' ? 'Nice. You wrote it from memory.' : 'Nice.', tone: 'good' }
      : { head: 'Done.', next: mode === 'memory' ? 'Write it once more from memory to help it stick.' : undefined, tone: 'info' });
  };

  const again = () => {
    pad.current?.clear();
    coach.reset();
    setStatus('writing');
  };

  if (loading) {
    return <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />;
  }
  if (!strokes || missing || error) {
    return (
      <section className="st-write">
        <p className="card st-paper-note">
          {error ? "The stroke guide didn't load." : 'There is no stroke guide for this character yet.'} Try writing it on paper.
        </p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </section>
    );
  }

  return (
    <section className="st-write st-write-steps" aria-label={`Writing ${char}`}>
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <p className="st-write-target">{target}</p>
      </div>
      <PassSteps passes={passes} at={at} done={status === 'done'} />
      <WritingPad ref={pad} strokes={strokes} mode={mode} label={char}
        onStrokeResult={coach.onStrokeResult} onComplete={complete} disabled={status !== 'writing'} />
      <CoachText line={coach.line} />
      <PadTools pad={pad} disabled={status !== 'writing'} onClear={coach.reset} />
      {mode === 'memory' && status === 'done' && (
        <details className="st-strip-peek">
          <summary>Stroke order</summary>
          <StrokeOrderStrip strokes={strokes} label={`Stroke order for ${char}`} />
        </details>
      )}
      <div className="st-footer">
        {status === 'done' ? (
          <>
            {mode === 'memory' && (
              <button type="button" className="btn secondary" onClick={again}>Write it again</button>
            )}
            <button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button>
          </>
        ) : (
          <button type="button" className="btn ghost st-grow" onClick={onSkip}>Skip writing</button>
        )}
      </div>
    </section>
  );
}
