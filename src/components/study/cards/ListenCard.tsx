import { useId, useState } from 'react';
import { selfGrade } from '../../../srs/answers.ts';
import { AudioButton } from '../AudioButton.tsx';
import { PitchLine } from '../PitchLine.tsx';
import { KanaText } from './KanaText.tsx';
import { Question, SelfGrade, useAutoPlay } from './parts.tsx';
import { shownWord } from './prepare.ts';
import type { CardProps } from './types.ts';

/** The word is heard, never shown, until the learner has recalled its meaning: then text, meaning and pitch. */
export function ListenCard({ prepared, onAnswer, mask }: CardProps<'listen'>) {
  const { word, accent, display } = prepared;
  const [revealed, setRevealed] = useState(false);
  const revealId = useId();
  useAutoPlay({ ref: word.ref }, { fallbackText: display });
  return (
    <>
      <Question ask="What does this mean?">
        <AudioButton source={{ ref: word.ref }} fallbackText={display} label="Play again" />
        {revealed && (
          <div className="st-reveal" id={revealId}>
            {/* A kanji still to be written from memory today stays in kana (leak guard). */}
            <KanaText text={shownWord(display, word, mask)} className="st-reveal-word" show="all" />
            {accent && <PitchLine accent={accent} kana={word.kana} size="sm" />}
            <p className="st-english">{word.en}</p>
          </div>
        )}
      </Question>
      {revealed ? (
        <SelfGrade describedBy={revealId} onGrade={(gotIt) => onAnswer({ grade: selfGrade(gotIt), mode: 'self', revealed: true })} />
      ) : (
        <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>Show the answer</button>
      )}
    </>
  );
}
