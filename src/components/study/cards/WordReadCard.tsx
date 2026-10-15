import { useEffect, useState } from 'react';
import { useCardRubyShow, useSettings } from '../../../lib/hooks.ts';
import { gradeWordRead, kanaMatches } from '../../../srs/answers.ts';
import { play } from '../../../speech/audio.ts';
import { Ruby } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { PitchLine } from '../PitchLine.tsx';
import { AnswerArea, fitStyle, Question, SelfGrade, type AnswerResult } from './parts.tsx';
import type { CardProps } from './types.ts';

/**
 * A word (inside a known carrier phrase when there is one) → type its reading; then the meaning, audio and pitch line
 * are revealed and the learner says whether they knew the meaning. Both halves are logged (`parts`).
 */
export function WordReadCard({ prepared, onAnswer, handsBusy }: CardProps<'word-read'>) {
  const { word, carrier, cue, accent, display, options, answer } = prepared;
  const show = useCardRubyShow();
  const { audio } = useSettings();
  const [reading, setReading] = useState<AnswerResult | null>(null);
  useEffect(() => {
    if (reading && audio) void play({ ref: word.ref }, { fallbackText: display });
  }, [reading, audio, word.ref, display]);

  return (
    <>
      <Question ask={carrier ? 'How do you read the underlined word?' : 'How do you read this word?'}>
        {carrier ? (
          <p className="st-sentence" lang="ja">
            <Ruby text={cue.before} show={show} />
            <u className="st-target">{cue.target}</u>
            <Ruby text={cue.after} show={show} />
          </p>
        ) : (
          <p className="st-big st-fit" lang="ja" style={fitStyle(cue.target)}>{cue.target}</p>
        )}
        {reading && (
          <div className="st-reveal">
            <p className="st-reveal-kana" lang="ja">{word.kana}</p>
            {accent && <PitchLine accent={accent} kana={word.kana} size="sm" />}
            <p className="st-english">{word.en}</p>
            {carrier && <p className="st-translation">{carrier.en}</p>}
            <AudioButton compact source={{ ref: word.ref }} fallbackText={display} label={`Listen to ${word.kana}`} />
          </div>
        )}
      </Question>
      {!reading ? (
        <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
          typed={{ kind: 'kana', label: 'Reading', check: (s) => kanaMatches(s, word.readings) }} onResult={setReading} />
      ) : (
        <>
          <p className={reading.correct ? 'st-verdict good' : 'st-verdict bad'} role="status">
            {reading.correct ? 'Reading: right' : <>Reading: <span lang="ja">{word.kana}</span></>}
          </p>
          <SelfGrade prompt="Knew the meaning?" missedLabel="No" gotItLabel="Yes"
            onGrade={(knewMeaning) => onAnswer({
              grade: gradeWordRead({ readingCorrect: reading.correct, retries: reading.retries, choice: reading.mode === 'choice', knewMeaning }),
              mode: reading.mode,
              parts: { reading: reading.correct, meaning: knewMeaning },
              revealed: true,
            })} />
        </>
      )}
    </>
  );
}
