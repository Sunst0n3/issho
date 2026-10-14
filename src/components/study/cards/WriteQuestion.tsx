// Writing from memory, used by the kana and kanji write cards. The pad checks
// each stroke; "Write on paper instead" shows the answer for a self-grade.

import { useRef, useState, type ReactNode } from 'react';
import { Rating } from 'ts-fsrs';
import type { CardRecord } from '../../../lib/types.ts';
import { gradeForWriting } from '../../../srs/answers.ts';
import { StrokeAnimation } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { WritingPad, type WritingPadHandle, type WritingResult } from '../../../writing/WritingPad.tsx';
import { Glyph } from '../../Glyph.tsx';
import { CoachText, PadTools, useStrokeCoach } from '../StrokeCoach.tsx';
import { SelfGrade } from './parts.tsx';
import type { CardAnswer } from './types.ts';

const NO_STROKES: string[] = [];

function writtenTitle(grade: number): string | undefined {
  if (grade === Rating.Good) return 'Well written';
  if (grade === Rating.Hard) return 'Written, with a little help';
  return undefined;
}

export function WriteQuestion({ card, char, ask, target, note, speak, onAnswer, practice = false }: {
  card: CardRecord;
  char: string;
  /** "Write the kanji for" */
  ask: string;
  /** What to write, e.g. the meaning and a reading. */
  target: ReactNode;
  /** The other half of the answer shown afterwards, e.g. the reading. */
  note?: ReactNode;
  /** Japanese read aloud by Listen afterwards. */
  speak?: string;
  onAnswer: (answer: CardAnswer) => void;
  practice?: boolean;
}) {
  const { strokes, loading, missing, error } = useStrokes(char);
  const pad = useRef<WritingPadHandle>(null);
  const [paper, setPaper] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState(false);
  const coach = useStrokeCoach(strokes ?? NO_STROKES, 'memory');
  // Without stroke data the pad can't check anything: write on paper instead.
  const onPaper = paper || missing || Boolean(error);

  const complete = (result: WritingResult) => {
    setFinished(true);
    const grade = gradeForWriting(result);
    onAnswer({
      grade,
      mode: 'written',
      correct: grade !== Rating.Again,
      feedback: { title: writtenTitle(grade), expected: char, expectedLang: 'ja', note, speak },
    });
  };

  const selfGrade = (grade: CardAnswer['grade']) => {
    setFinished(true);
    onAnswer({ grade, mode: 'self', correct: grade !== Rating.Again });
  };

  return (
    <section className="st-question st-write">
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <p className="st-write-target">{target}</p>
      </div>

      {onPaper ? (
        <div className="st-paper">
          {!revealed ? (
            <>
              <p className="card st-paper-note">
                Write it on paper (or in the air). When you are done, check it.
              </p>
              <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>Show the answer</button>
            </>
          ) : (
            <>
              {strokes ? <StrokeAnimation strokes={strokes} label={char} /> : (
                <div className="st-paper-answer"><Glyph char={char} size={120} /></div>
              )}
              {!finished && <SelfGrade card={card} onGrade={selfGrade} intervals={!practice} prompt="How did your writing compare?" />}
            </>
          )}
        </div>
      ) : loading || !strokes ? (
        <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />
      ) : (
        <>
          <WritingPad ref={pad} strokes={strokes} mode="memory" label={`the answer to: ${ask}`}
            onStrokeResult={coach.onStrokeResult} onComplete={complete} />
          {!finished && (
            <>
              <CoachText line={coach.line} />
              <PadTools pad={pad} last="giveUp" />
              <button type="button" className="btn ghost small st-center" onClick={() => setPaper(true)}>
                Write on paper instead
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
