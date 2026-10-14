// Free writing practice on a reference page (kanji detail, kana chart).
// Practice only: nothing is graded or scheduled.
import { useRef, useState } from 'react';
import {
  describeStroke,
  mistakeMessage,
  WritingPad,
  type WritingMode,
  type WritingPadHandle,
  type WritingResult,
} from '../../writing/index.ts';
import { Icon } from '../ui.tsx';
import { Segmented } from './controls.tsx';

const MODES = [
  { value: 'trace', label: 'Trace' },
  { value: 'guided', label: 'Guided' },
  { value: 'memory', label: 'Memory' },
] as const;

function nextHint(strokes: readonly string[], done: number, mode: WritingMode): string {
  if (mode === 'memory') return done === 0 ? 'Write it from memory. Tap Hint if you get stuck.' : `${done} of ${strokes.length} strokes.`;
  if (done >= strokes.length) return '';
  return `Stroke ${done + 1}: ${describeStroke(strokes[done])}.`;
}

function resultText(r: WritingResult): string {
  if (r.gaveUp) return 'Here it is. Watch the order, then try again.';
  if (r.failedStrokes === 0 && r.hintsUsed === 0) return 'Every stroke right first time.';
  return `Done. ${r.failedStrokes} of ${r.strokeCount} strokes needed another go.`;
}

export function PracticePad({ strokes, label }: { strokes: readonly string[]; label: string }) {
  const pad = useRef<WritingPadHandle>(null);
  const [mode, setMode] = useState<WritingMode>('trace');
  const [done, setDone] = useState(0);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: nextHint(strokes, 0, 'trace') });
  const [result, setResult] = useState<WritingResult>();

  const restart = (m: WritingMode) => {
    setDone(0);
    setResult(undefined);
    setNote({ text: nextHint(strokes, 0, m) });
  };

  return (
    <div className="hm-practice">
      <Segmented label="Practice mode" options={MODES} value={mode}
        onChange={(m) => { setMode(m); restart(m); }} />
      <WritingPad ref={pad} strokes={strokes} mode={mode} label={label}
        onStrokeResult={(index, ok, detail) => {
          if (ok) {
            setDone(index + 1);
            const next = nextHint(strokes, index + 1, mode);
            setNote({ text: index + 1 < strokes.length && mode !== 'memory' ? `Stroke ${index + 1} looks good. ${next}` : next });
          } else {
            setNote({ text: mistakeMessage(detail, index), bad: true });
          }
        }}
        onComplete={(r) => { setResult(r); setNote({ text: resultText(r) }); }} />
      {/* The pad announces strokes to screen readers itself, so this line stays silent. */}
      <p className={note.bad ? 'hm-practice-note bad' : 'hm-practice-note'}>{note.text}</p>
      <div className="hm-practice-actions">
        {result ? (
          <button type="button" className="btn ink small hm-practice-again" onClick={() => { pad.current?.clear(); restart(mode); }}>
            <Icon name="refresh" size={18} />Write it again
          </button>
        ) : (
          <>
            <button type="button" className="btn secondary small" disabled={done === 0}
              onClick={() => {
                pad.current?.undo();
                const left = Math.max(0, done - 1);
                setDone(left);
                setNote({ text: nextHint(strokes, left, mode) });
              }}>
              <Icon name="undo" size={18} />Undo
            </button>
            <button type="button" className="btn secondary small" onClick={() => pad.current?.hint()}>
              <Icon name="bulb" size={18} />Hint
            </button>
            <button type="button" className="btn secondary small" onClick={() => { pad.current?.clear(); restart(mode); }}>
              <Icon name="trash" size={18} />Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
