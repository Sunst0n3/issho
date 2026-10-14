// Free writing practice for one character (not graded): trace, guided or from
// memory on the pad, or on paper with the stroke animation as the check.

import { useRef, useState, type ReactNode } from 'react';
import { StrokeAnimation } from '../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../writing/useStrokes.ts';
import { WritingPad, type WritingMode, type WritingPadHandle } from '../../writing/WritingPad.tsx';
import { Icon } from '../ui.tsx';
import { CoachText, PadTools, useStrokeCoach } from './StrokeCoach.tsx';
import { useStudyTimer } from './time.ts';

export type PracticeMode = WritingMode | 'paper';

const MODES: { mode: PracticeMode; label: string }[] = [
  { mode: 'trace', label: 'Trace' },
  { mode: 'guided', label: 'Guided' },
  { mode: 'memory', label: 'Memory' },
  { mode: 'paper', label: 'Paper' },
];

const MODE_KEY = 'issho.write.mode';
const NO_STROKES: string[] = [];

function savedMode(): PracticeMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.some((x) => x.mode === m) ? (m as PracticeMode) : 'guided';
  } catch {
    return 'guided';
  }
}

export function ModeSwitch({ mode, onChange }: { mode: PracticeMode; onChange: (mode: PracticeMode) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Writing mode">
      {MODES.map((m) => (
        <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} onClick={() => onChange(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function PracticePad({ char, ask, target }: { char: string; ask: string; target: ReactNode }) {
  useStudyTimer();
  const { strokes, loading, missing, error } = useStrokes(char);
  const [mode, setMode] = useState<PracticeMode>(savedMode);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);
  const pad = useRef<WritingPadHandle>(null);
  const padMode: WritingMode = mode === 'paper' ? 'memory' : mode;
  const coach = useStrokeCoach(strokes ?? NO_STROKES, padMode);

  const changeMode = (next: PracticeMode) => {
    setMode(next);
    setRevealed(false);
    setDone(false);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Remembering the mode is a convenience only.
    }
  };

  const again = () => {
    pad.current?.clear();
    coach.reset();
    setDone(false);
  };

  const noPad = !strokes || missing || error;
  return (
    <section className="st-write" aria-label={`Practise writing ${char}`}>
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <p className="st-write-target">{target}</p>
      </div>
      <ModeSwitch mode={mode} onChange={changeMode} />

      {loading ? (
        <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />
      ) : mode === 'paper' || noPad ? (
        <div className="st-paper">
          {noPad && <p className="muted">There is no stroke guide for this character yet.</p>}
          {revealed && strokes ? (
            <StrokeAnimation strokes={strokes} label={char} />
          ) : (
            <>
              <p className="card st-paper-note">Write it on paper, then check it against the stroke order.</p>
              {strokes && (
                <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>
                  <Icon name="eye" size={18} />Show the strokes
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <WritingPad ref={pad} strokes={strokes} mode={padMode} label={char}
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
            <PadTools pad={pad} onClear={coach.reset} />
          )}
        </>
      )}
    </section>
  );
}
