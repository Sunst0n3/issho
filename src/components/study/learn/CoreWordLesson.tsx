import { useEffect, useState } from 'react';
import type { WordInfo } from '../../../lib/data.ts';
import type { AccentInfo, RubyText } from '../../../lib/types.ts';
import { AudioButton } from '../AudioButton.tsx';
import { KanaText } from '../cards/KanaText.tsx';
import { useAutoPlay } from '../cards/parts.tsx';
import { MixedText } from '../MixedText.tsx';
import { PitchLine } from '../PitchLine.tsx';

/** The text appears this long after the audio starts: hear it first. */
export const LISTEN_FIRST_MS = 1500;

const REGISTER: Record<string, string> = {
  plain: 'Casual: with your partner and friends.',
  polite: 'Polite: with people you don’t know well.',
};

/** A core word: audio first, a short pause, then the text (kana until it is spelled), meaning, register and pitch. */
export function CoreWordLesson({ word, display, accent, onNext }: {
  word: WordInfo;
  display: RubyText;
  accent?: AccentInfo;
  onNext: () => void;
}) {
  const [shown, setShown] = useState(false);
  useAutoPlay({ ref: word.ref }, { fallbackText: display });
  useEffect(() => {
    const t = setTimeout(() => setShown(true), LISTEN_FIRST_MS);
    return () => clearTimeout(t);
  }, []);
  const register = word.register ? REGISTER[word.register] : undefined;
  return (
    <>
      <article className="card st-lesson st-lesson-kana">
        <p className="label">New word</p>
        {shown ? (
          <>
            <KanaText text={display} className="st-big st-lesson-word" show="all" />
            {accent && <PitchLine accent={accent} kana={word.kana} />}
            <h2 className="st-lesson-meaning">{word.en}</h2>
          </>
        ) : (
          <p className="st-listen-first">Listen first</p>
        )}
        <AudioButton source={{ ref: word.ref }} fallbackText={display} label="Listen again" />
        {shown && register && <p className="st-note">{register}</p>}
        {shown && word.note && <p className="st-note"><MixedText text={word.note} /></p>}
      </article>
      <div className="st-footer">
        {shown ? (
          <button type="button" className="btn ink st-grow" onClick={onNext}>Got it</button>
        ) : (
          <button type="button" className="btn secondary st-grow" onClick={() => setShown(true)}>Show the word</button>
        )}
      </div>
    </>
  );
}
