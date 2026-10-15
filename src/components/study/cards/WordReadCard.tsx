import { useEffect, useId, useRef, useState } from 'react';
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
 * are revealed and the learner says whether they knew the meaning. Both halves are logged (`parts`). Shown alone, a
 * written form that several words share (人: ひと, じん, にん) takes any of their readings; the reveal says which word
 * the card is about.
 */
export function WordReadCard({ prepared, onAnswer, handsBusy }: CardProps<'word-read'>) {
  const { word, carrier, cue, accent, display, options, answer, homographs } = prepared;
  const show = useCardRubyShow();
  const { audio } = useSettings();
  const [reading, setReading] = useState<AnswerResult | null>(null);
  /** The other word's reading the learner typed, when it was one (ひと on the じん card). */
  const otherWord = useRef<string | null>(null);
  const revealId = useId();
  useEffect(() => {
    if (reading && audio) void play({ ref: word.ref }, { fallbackText: display });
  }, [reading, audio, word.ref, display]);

  const check = (s: string) => {
    if (kanaMatches(s, word.readings)) {
      otherWord.current = null;
      return true;
    }
    otherWord.current = homographs.find((h) => kanaMatches(s, h)) ?? null;
    return otherWord.current !== null;
  };
  const other = reading?.correct && reading.mode === 'typed' ? otherWord.current : null;

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
        {homographs.length > 0 && !reading && (
          <p className="st-note">More than one word is written <span lang="ja">{cue.target}</span>: any of their readings counts.</p>
        )}
        {reading && (
          <div className="st-reveal" id={revealId}>
            {other && (
              <p className="st-note">
                <span lang="ja">{other}</span> is right too. This card is about <span lang="ja">{word.kana}</span>:
              </p>
            )}
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
          typed={{ kind: 'kana', label: 'Reading', check }} onResult={setReading} />
      ) : (
        <>
          <p className={reading.correct ? 'st-verdict good' : 'st-verdict bad'} role="status">
            {reading.correct ? 'Reading: right' : <>Reading: <span lang="ja">{word.kana}</span></>}
          </p>
          <SelfGrade prompt="Knew the meaning?" missedLabel="No" gotItLabel="Yes" describedBy={revealId}
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
