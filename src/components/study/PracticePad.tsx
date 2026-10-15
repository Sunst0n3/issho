// Free writing practice for one character, never graded: the stroke order animated, then a guided pad (start dots,
// each stroke checked) to copy it as often as you like.

import { useRef, useState, type ReactNode } from 'react';
import { StrokeAnimation } from '../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../writing/useStrokes.ts';
import { WritingPad, type WritingPadHandle } from '../../writing/WritingPad.tsx';
import { Icon } from '../ui.tsx';
import { useFocusHeading } from './focus.ts';
import { padLabel } from './learn/WriteSteps.tsx';
import { CoachText, PadTools, useStrokeCoach } from './StrokeCoach.tsx';

const NO_STROKES: string[] = [];

export function PracticePad({ char, ask, target, label }: {
  char: string;
  ask: string;
  target: ReactNode;
  /** `target` as plain text, for the pad's accessible name. */
  label?: string;
}) {
  const { strokes, loading, missing, error } = useStrokes(char);
  const [done, setDone] = useState(false);
  const pad = useRef<WritingPadHandle>(null);
  const root = useRef<HTMLElement>(null);
  useFocusHeading(root, char);
  const coach = useStrokeCoach(strokes ?? NO_STROKES, 'guided');

  const again = () => {
    pad.current?.clear();
    coach.reset();
    setDone(false);
  };

  return (
    <section className="st-write" aria-label={`Practice writing ${char}`} ref={root}>
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <div className="st-write-target">{target}</div>
      </div>
      {loading ? (
        <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />
      ) : !strokes || missing || error ? (
        <p className="card st-paper-note">There is no stroke guide for this character yet.</p>
      ) : (
        <>
          <StrokeAnimation strokes={strokes} label={`Stroke order of ${char}`} />
          <WritingPad ref={pad} strokes={strokes} mode="guided" label={padLabel(char, 'guided', label)}
            onStrokeResult={coach.onStrokeResult}
            onComplete={(r) => {
              setDone(true);
              coach.setLine(r.gaveUp || r.mistakes > 0 || r.hintsUsed > 0
                ? { head: 'Done.', next: 'Clear it and write it once more.', tone: 'info' }
                : { head: 'Nice. Clean strokes.', tone: 'good' });
            }} />
          <CoachText line={coach.line} />
          {done ? (
            <button type="button" className="btn secondary block" onClick={again}>
              <Icon name="refresh" size={18} />Write it again
            </button>
          ) : (
            <PadTools pad={pad} coach={coach} onClear={coach.reset} />
          )}
        </>
      )}
    </section>
  );
}
