// Writing from memory on a review card: the recall pad judges the whole character when the learner taps Done
// (stroke order never counts against it). When it says Again, "I wrote it right" re-grades the card Hard. "Write on
// paper" (not in an anywhere sitting) shows the answer after Done for a Missed / Got it self-check.

import { useState, type ReactNode } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import { useSettings } from '../../../lib/hooks.ts';
import { gradeForRecallWriting } from '../../../srs/answers.ts';
import { StrokeAnimation } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { WritingPad, type RecallResult } from '../../../writing/WritingPad.tsx';
import { Glyph } from '../../Glyph.tsx';
import { SelfGrade } from './parts.tsx';
import type { CardAnswer } from './types.ts';

/** What went wrong, in one line, for the learner to compare with the model. */
export function recallSummary(r: RecallResult): string {
  const { missing, extra, unmatched } = r.match;
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} ${missing.length === 1 ? 'stroke' : 'strokes'} missing`);
  if (extra.length) parts.push(`${extra.length} extra ${extra.length === 1 ? 'stroke' : 'strokes'}`);
  if (unmatched.length) parts.push(`${unmatched.length} ${unmatched.length === 1 ? 'stroke looks' : 'strokes look'} off`);
  return parts.length ? `${parts.join(', ')}.` : 'Compare your writing with the model.';
}

export function WriteQuestion({ char, ask, target, label, paperAllowed = true, onAnswer }: {
  char: string;
  /** "Write the kanji" */
  ask: string;
  /** The prompt: keyword and anchor with □, or the sound. Never the character itself. */
  target: ReactNode;
  /** What to write as plain text, for the pad's accessible name, without the answer. */
  label: string;
  paperAllowed?: boolean;
  onAnswer: (answer: CardAnswer) => void;
}) {
  const { strokes, loading, missing, error } = useStrokes(char);
  const { writingHand } = useSettings();
  const [paper, setPaper] = useState(false);
  const [checking, setChecking] = useState(false);
  const [judged, setJudged] = useState<RecallResult | null>(null);
  const [answered, setAnswered] = useState(false);
  // Without stroke data the pad can't judge: write it (on paper, or in the air when there is no pen) and self-check.
  const noPad = !loading && (!strokes || missing || Boolean(error));
  const selfCheck = paper || noPad;

  const answer = (a: CardAnswer) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(a);
  };

  const recallDone = (r: RecallResult) => {
    const grade: Grade = gradeForRecallWriting({
      strokeCount: strokes?.length ?? r.match.assignment.length,
      missing: r.match.missing.length,
      extra: r.match.extra.length,
      unmatched: r.match.unmatched.length,
      hintUsed: r.hintUsed,
    });
    if (grade === Rating.Again) setJudged(r);
    else answer({ grade, mode: 'written', input: writingHand });
  };

  return (
    <section className="st-question st-write">
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <div className="st-write-target">{target}</div>
      </div>

      {selfCheck ? (
        <div className="st-paper">
          {!checking ? (
            <>
              <p className="card st-paper-note">
                {paperAllowed ? 'Write it on paper. When you are done, check it.' : 'Write it in the air or on your palm. When you are done, check it.'}
              </p>
              <button type="button" className="btn ink block" onClick={() => setChecking(true)}>Done</button>
            </>
          ) : (
            <>
              {strokes ? <StrokeAnimation strokes={strokes} label={char} /> : (
                <div className="st-paper-answer"><Glyph char={char} size={120} /></div>
              )}
              {!answered && (
                <SelfGrade prompt="How did your writing compare?"
                  onGrade={(gotIt) => answer(paperAllowed
                    ? { grade: gotIt ? Rating.Good : Rating.Again, mode: 'paper', input: 'paper', revealed: true }
                    : { grade: gotIt ? Rating.Good : Rating.Again, mode: 'self', revealed: true })} />
              )}
            </>
          )}
        </div>
      ) : loading || !strokes ? (
        <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />
      ) : (
        <>
          <WritingPad strokes={strokes} mode="recall" label={label} onRecallDone={recallDone} disabled={answered} />
          {judged && !answered && (
            <div className="feedback bad st-feedback" role="status">
              <p className="st-fb-title">Not quite</p>
              <p className="st-fb-note">{recallSummary(judged)}</p>
              <div className="st-row">
                <button type="button" className="btn secondary small" onClick={() => answer({ grade: Rating.Hard, mode: 'written', input: writingHand, override: true })}>
                  I wrote it right
                </button>
                <button type="button" className="btn ink small st-grow" onClick={() => answer({ grade: Rating.Again, mode: 'written', input: writingHand })}>
                  Continue
                </button>
              </div>
            </div>
          )}
          {!judged && !answered && paperAllowed && (
            <button type="button" className="btn ghost small st-center" onClick={() => setPaper(true)}>Write on paper</button>
          )}
        </>
      )}
    </section>
  );
}
