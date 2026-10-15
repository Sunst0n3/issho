import { useEffect, useRef, useState } from 'react';
import { Rating } from 'ts-fsrs';
import type { WordInfo } from '../../../lib/data.ts';
import { gradeFor, kanaMatches } from '../../../srs/answers.ts';
import { spokenMatches } from '../../../speech/compare.ts';
import { listen, recognitionAvailable, type Listening } from '../../../speech/recognition.ts';
import { Icon } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { MixedText } from '../MixedText.tsx';
import { KanaText } from './KanaText.tsx';
import { AnswerArea, Question, SelfGrade } from './parts.tsx';
import { shownWord, writtenMatches } from './prepare.ts';
import type { CardProps } from './types.ts';

/** Failed recognitions before "I said it — check myself" is offered. */
export const SPEECH_TRIES = 2;

const REGISTER_NOTE: Record<string, string> = {
  plain: 'casual, to your partner',
  polite: 'polite, to someone you don’t know well',
};

/** Kana or kanji: a note with Japanese in it holds the answer or a form of it ("casual: わかった", "polite: いきます"). */
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/u;

/**
 * The context note under the English. Word notes are usage notes, and nearly all that hold Japanese spell the answer
 * or a form of it; the cue side never shows answer material (§3.2.4), so such a note gives way to the register note.
 */
export function cueNote(word: Pick<WordInfo, 'note' | 'register'>): string | undefined {
  if (word.note && !JAPANESE.test(word.note)) return word.note;
  return word.register ? REGISTER_NOTE[word.register] : undefined;
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * English → say or type the Japanese. The mic appears only where speech recognition works and the phone is online;
 * after two failed recognitions the learner may grade themselves (at most Hard). Typing always works.
 */
export function ProduceCard({ prepared, onAnswer, handsBusy, mask }: CardProps<'produce'>) {
  const { word, display, options, answer } = prepared;
  const [canSpeak] = useState(() => recognitionAvailable() && online());
  const [listening, setListening] = useState(false);
  const [fails, setFails] = useState(0);
  const [selfCheck, setSelfCheck] = useState(false);
  const [done, setDone] = useState(false);
  const current = useRef<Listening | null>(null);
  useEffect(() => () => current.current?.stop(), []);

  const answer_ = (a: Parameters<typeof onAnswer>[0]) => {
    if (done) return;
    setDone(true);
    current.current?.stop();
    onAnswer(a);
  };

  const speak = () => {
    if (listening) {
      current.current?.stop();
      return;
    }
    const l = listen({ lang: 'ja-JP' });
    current.current = l;
    setListening(true);
    l.result.then(
      (heard) => {
        if (current.current !== l) return;
        setListening(false);
        if (heard && spokenMatches(heard, { written: word.written, readings: word.readings })) {
          answer_({ grade: Rating.Good, mode: 'spoken' });
        } else setFails((n) => n + 1);
      },
      () => {
        if (current.current !== l) return;
        setListening(false);
        setFails((n) => n + 1);
      },
    );
  };

  const note = cueNote(word);
  return (
    <>
      <Question ask="Say it in Japanese">
        <p className="st-english">{word.en}</p>
        {note && <p className="st-note"><MixedText text={note} /></p>}
        {selfCheck && (
          <div className="st-reveal">
            <KanaText text={shownWord(display, word, mask)} className="st-reveal-word" show="all" />
            <AudioButton compact source={{ ref: word.ref }} fallbackText={display} label="Listen" />
          </div>
        )}
      </Question>
      {selfCheck ? (
        <SelfGrade prompt="Did you say it?" onGrade={(gotIt) => answer_({ grade: gotIt ? Rating.Hard : Rating.Again, mode: 'spoken', revealed: true })} />
      ) : (
        <>
          {canSpeak && !done && (
            <div className="st-speak">
              <button type="button" className={listening ? 'btn primary block' : 'btn secondary block'} onClick={speak} aria-pressed={listening}>
                <Icon name={listening ? 'stop' : 'mic'} size={18} />{listening ? 'Listening… tap to stop' : 'Say it'}
              </button>
              {fails > 0 && fails < SPEECH_TRIES && <p className="st-retry" role="status">Didn't catch that. Try once more, or type it.</p>}
              {fails >= SPEECH_TRIES && (
                <button type="button" className="btn ghost small st-center" onClick={() => setSelfCheck(true)}>
                  I said it — check myself
                </button>
              )}
            </div>
          )}
          <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
            typed={{ kind: 'kana', label: 'Or type it', check: (s) => kanaMatches(s, word.readings) || writtenMatches(s, [{ written: word.written, readings: word.readings }]) }}
            onResult={(r) => answer_({ grade: gradeFor({ correct: r.correct, retries: r.retries, choice: r.mode === 'choice' }), mode: r.mode })} />
        </>
      )}
    </>
  );
}
