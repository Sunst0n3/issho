import { useState } from 'react';
import { Rating } from 'ts-fsrs';
import { useRubyShow } from '../../../lib/hooks.ts';
import { SpeakButton } from '../../SpeakButton.tsx';
import { Ruby } from '../../ui.tsx';
import { Question, SelfGrade } from './parts.tsx';
import type { CardProps } from './types.ts';

/** a saved sentence: read it, check the translation, grade yourself */
export function SentenceReadCard({ prepared, onAnswer, practice }: CardProps<'sentence-read'>) {
  const { sentence, card } = prepared;
  const show = useRubyShow();
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <Question ask="Read this sentence out loud">
        <Ruby className="st-sentence" text={sentence.jp} show={show} />
        {revealed && <p className="st-translation">{sentence.en}</p>}
      </Question>
      {revealed ? (
        <>
          <div className="st-row st-center"><SpeakButton text={sentence.jp} /></div>
          <SelfGrade card={card} intervals={!practice} prompt="Did you understand it?"
            onGrade={(grade) => onAnswer({ grade, mode: 'self', correct: grade !== Rating.Again })} />
        </>
      ) : (
        <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>Show translation</button>
      )}
    </>
  );
}
