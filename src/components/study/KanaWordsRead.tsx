// Sprint reading: real words made only of taught kana. Read each aloud first, then hear it. Ungraded. A word counts
// as the day's reading retrieval of the read card of each kana in it that was introduced today (once per card).

import { useRef, useState } from 'react';
import { usePlayback } from '../../speech/audio.ts';
import { AudioButton } from './AudioButton.tsx';
import { KanaText } from './cards/KanaText.tsx';
import { useFocusHeading, useScrollToTop } from './focus.ts';

export interface KanaWord { kana: string; en: string; ref: string }

/** The read-card ids of today's kana that appear in the word. */
export function readCardsIn(word: string, todayReadCards: ReadonlySet<string>): string[] {
  return [...new Set([...word].map((c) => `kana:${c}|read`))].filter((id) => todayReadCards.has(id));
}

export function KanaWordsRead({ words, todayReadCards = new Set(), onRetrieved, mayRetrieve, onDone, doneLabel = 'Continue' }: {
  words: readonly KanaWord[];
  /** Read cards of kana introduced today. */
  todayReadCards?: ReadonlySet<string>;
  onRetrieved?: (cardId: string) => void;
  mayRetrieve?: (cardId: string) => boolean;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [at, setAt] = useState(0);
  const [heard, setHeard] = useState(false);
  const { play } = usePlayback();
  const counted = useRef(new Set<string>());
  const root = useRef<HTMLElement>(null);
  useScrollToTop(at);
  useFocusHeading(root, at);
  const word = words[at];
  if (!word) return null;

  const hear = () => {
    setHeard(true);
    void play({ ref: word.ref }, { fallbackText: word.kana });
    for (const id of readCardsIn(word.kana, todayReadCards)) {
      if (counted.current.has(id) || !(mayRetrieve?.(id) ?? true)) continue;
      counted.current.add(id);
      onRetrieved?.(id);
    }
  };
  const next = () => {
    setHeard(false);
    if (at + 1 < words.length) setAt(at + 1);
    else onDone();
  };

  return (
    <section className="st-reading" ref={root} aria-labelledby="kana-words-title">
      <h2 id="kana-words-title" className="st-ask">Read it aloud, then hear it</h2>
      <p className="label">Word {at + 1} / {words.length}</p>
      <div className="card st-prompt">
        <KanaText text={word.kana} className="st-big" />
        {heard && <p className="st-english">{word.en}</p>}
      </div>
      <div className="st-footer">
        {heard ? (
          <>
            <AudioButton compact source={{ ref: word.ref }} fallbackText={word.kana} label="Hear it again" />
            <button type="button" className="btn ink st-grow" onClick={next}>{at + 1 < words.length ? 'Next word' : doneLabel}</button>
          </>
        ) : (
          <button type="button" className="btn ink st-grow" onClick={hear}>Hear it</button>
        )}
      </div>
    </section>
  );
}
