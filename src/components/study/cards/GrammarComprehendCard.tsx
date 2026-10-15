import { useId, useState } from 'react';
import { clipRef } from '../../../../shared/voicevox.ts';
import { useCardRubyShow } from '../../../lib/hooks.ts';
import { selfGrade } from '../../../srs/answers.ts';
import { AudioButton } from '../AudioButton.tsx';
import { MixedText } from '../MixedText.tsx';
import { KanaText } from './KanaText.tsx';
import { Question, SelfGrade, useAutoPlay } from './parts.tsx';
import type { CardProps } from './types.ts';

/** A grammar example, read and heard → recall what it means → reveal → Missed / Got it. */
export function GrammarComprehendCard({ prepared, onAnswer }: CardProps<'grammar-comprehend'>) {
  const { point, example, exampleIndex } = prepared;
  const show = useCardRubyShow();
  const [revealed, setRevealed] = useState(false);
  const revealId = useId();
  const source = { ref: clipRef.grammarExample(point.id, exampleIndex) };
  useAutoPlay(source, { fallbackText: example.jp });
  return (
    <>
      <Question ask="What does this mean?">
        <KanaText text={example.jp} show={show} className="st-sentence" />
        <AudioButton compact source={source} fallbackText={example.jp} label="Listen to the sentence" />
        {revealed && (
          <div className="st-reveal" id={revealId}>
            <p className="st-english"><MixedText text={example.en} /></p>
            <p className="st-note"><MixedText text={point.title} /></p>
          </div>
        )}
      </Question>
      {revealed ? (
        <SelfGrade describedBy={revealId} onGrade={(gotIt) => onAnswer({ grade: selfGrade(gotIt), mode: 'self', revealed: true })} />
      ) : (
        <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>Show the meaning</button>
      )}
    </>
  );
}
