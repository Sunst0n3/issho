// The "Kana check" can-do on the day the sprint ends: ten katakana menu words, each shown for 3 seconds to read aloud,
// then heard. Ungraded. At the end the milestone is recorded and the M0 card says what the learner can now do.

import { useEffect, useRef, useState } from 'react';
import { recordMilestone } from '../../../srs/milestones.ts';
import { usePlayback } from '../../../speech/audio.ts';
import { AudioButton } from '../AudioButton.tsx';
import { useScrollToTop } from '../focus.ts';

/** Seconds each word is shown before it is read out. */
export const KANA_CHECK_SECONDS = 3;
export const KANA_CHECK_MILESTONE = 'kana-check';

export function KanaCheck({ words, onDone }: {
  words: readonly { kana: string; en: string; ref: string }[];
  onDone: () => void;
}) {
  const [at, setAt] = useState(0);
  const [heard, setHeard] = useState(false);
  const [finished, setFinished] = useState(false);
  const { play } = usePlayback();
  const recorded = useRef(false);
  const word = words[at];
  useScrollToTop(`${at}:${finished}`);

  // Read it aloud within 3 seconds, then hear it.
  useEffect(() => {
    if (!word || heard || finished) return;
    const t = setTimeout(() => {
      setHeard(true);
      void play({ ref: word.ref }, { fallbackText: word.kana });
    }, KANA_CHECK_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [word, heard, finished, play]);

  useEffect(() => {
    if (!finished || recorded.current) return;
    recorded.current = true;
    void recordMilestone(KANA_CHECK_MILESTONE).catch((e: unknown) => console.error('could not record the kana check', e));
  }, [finished]);

  if (finished || !word) {
    return (
      <section className="st-summary st-milestone" aria-labelledby="kana-check-done">
        <p className="st-eyebrow" lang="ja">できた</p>
        <h2 id="kana-check-done" className="st-summary-title">You can read a katakana menu</h2>
        <p className="muted">Hiragana and katakana are yours now. From here on, kanji, words and stories.</p>
        <div className="st-footer">
          <button type="button" className="btn primary st-grow" onClick={onDone}>Continue</button>
        </div>
      </section>
    );
  }

  const next = () => {
    setHeard(false);
    if (at + 1 < words.length) setAt(at + 1);
    else setFinished(true);
  };

  return (
    <section className="st-reading" aria-labelledby="kana-check-title">
      <h2 id="kana-check-title" className="st-ask">Kana check · read it aloud</h2>
      <p className="label">Word {at + 1} / {words.length}</p>
      <div className="card st-prompt">
        <p className="st-big" lang="ja">{word.kana}</p>
        {!heard && <div className="st-timer" aria-hidden="true"><span key={at} style={{ animationDuration: `${KANA_CHECK_SECONDS}s` }} /></div>}
        {heard && <p className="st-english">{word.en}</p>}
      </div>
      <div className="st-footer">
        {heard ? (
          <>
            <AudioButton compact source={{ ref: word.ref }} fallbackText={word.kana} label="Hear it again" />
            <button type="button" className="btn ink st-grow" onClick={next}>{at + 1 < words.length ? 'Next word' : 'Finish'}</button>
          </>
        ) : (
          <button type="button" className="btn secondary st-grow" onClick={() => { setHeard(true); void play({ ref: word.ref }, { fallbackText: word.kana }); }}>
            Hear it now
          </button>
        )}
      </div>
    </section>
  );
}
