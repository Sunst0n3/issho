import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';
import { getSettings } from '../../../lib/db.ts';
import { speak } from '../../../speech/tts.ts';
import { SpeakButton } from '../../SpeakButton.tsx';
import { untilText } from '../format.ts';
import type { FeedbackContent } from './types.ts';

/**
 * After an answer: right or not, the full answer, a kanji breakdown for words
 * and when the card comes back. Listen and Continue sit underneath.
 */
export function FeedbackPanel({ correct, content, due, practice = false, onContinue }: {
  correct: boolean;
  content: FeedbackContent;
  /** The card's next due date once the grade is saved. */
  due?: Date;
  practice?: boolean;
  onContinue: () => void;
}) {
  // Undefined until settings are read, so a default never plays audio the learner turned off.
  const audio = useLiveQuery(async () => (await getSettings()).audio, []);
  const continueRef = useRef<HTMLButtonElement>(null);
  const said = useRef(false);

  useEffect(() => continueRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (!audio || !content.speak || said.current) return;
    said.current = true;
    void speak(content.speak);
  }, [audio, content.speak]);

  const { expected, expectedLang, note, breakdown, title } = content;
  const headline = title ?? (correct ? 'Correct' : undefined);
  let when = '';
  if (practice) when = 'Extra practice: no new grade this time.';
  else if (due) when = `Reviewing again ${untilText(due)}`;

  return (
    <>
      <div className={correct ? 'feedback good st-feedback' : 'feedback bad st-feedback'} role="status">
        <p className="st-fb-title">
          {headline ?? <>Not quite: it's <span lang={expectedLang}>{expected}</span></>}
        </p>
        {note && <p className="st-fb-note">{note}</p>}
        {breakdown && breakdown.length > 0 && (
          <p className="st-fb-breakdown">
            {breakdown.map((part, i) => (
              <span key={part.char}>
                {i > 0 && <span aria-hidden="true"> + </span>}
                <span lang="ja" className="st-fb-char">{part.char}</span>
                {part.meaning && <> {part.meaning}</>}
              </span>
            ))}
          </p>
        )}
        <p className="st-fb-when">{when || ' '}</p>
      </div>
      <div className="st-footer">
        {content.speak && <SpeakButton text={content.speak} compact />}
        <button ref={continueRef} type="button" className="btn ink st-grow" onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}
