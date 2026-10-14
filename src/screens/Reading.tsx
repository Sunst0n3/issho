// Read & shadow on its own: five sentences at your level, plus the sentences
// you saved (tap one to read it again).

import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReadingDrill } from '../components/study/ReadingDrill.tsx';
import { unsaveSentence, type SentenceLike } from '../components/study/sentences.ts';
import { SessionHeader } from '../components/study/SessionChrome.tsx';
import { useStudyTimer } from '../components/study/time.ts';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { useRubyShow } from '../lib/hooks.ts';
import { pickSentences } from '../srs/planner.ts';
import '../components/study/study.css';

const SENTENCES_PER_ROUND = 5;

function Drill({ sentences, onClose, onDone }: { sentences: SentenceLike[]; onClose: () => void; onDone: () => void }) {
  useStudyTimer();
  const [index, setIndex] = useState(0);
  const onProgress = useCallback((i: number) => setIndex(i), []);
  return (
    <Screen label="Read and shadow">
      <SessionHeader progress={index / sentences.length} label={`Read ${index + 1} / ${sentences.length}`} onClose={onClose} />
      <ReadingDrill sentences={sentences} onProgress={onProgress} onDone={onDone} doneLabel="Finish" />
    </Screen>
  );
}

function SavedList({ onRead }: { onRead: (s: SentenceLike) => void }) {
  const saved = useLiveQuery(() => db.savedSentences.orderBy('savedAt').reverse().toArray(), []);
  const show = useRubyShow();
  if (!saved) return <div className="st-skeleton st-skeleton-list" aria-busy="true" aria-label="Loading saved sentences" />;
  if (!saved.length) {
    return <p className="empty">Save a sentence while reading and it comes back as a review card. Your saved sentences will be listed here.</p>;
  }
  return (
    <ul className="card st-saved">
      {saved.map((s) => (
        <li key={s.id}>
          <button type="button" className="st-saved-text" onClick={() => onRead(s)}>
            <Ruby className="st-saved-jp" text={s.jp} show={show} />
            <span className="st-word-en">{s.en}</span>
          </button>
          <button type="button" className="icon-btn" aria-label="Remove from saved" onClick={() => void unsaveSentence(s.id)}>
            <Icon name="trash" size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Reading() {
  const [round, setRound] = useState(0);
  const picks = useAsync(() => pickSentences(SENTENCES_PER_ROUND), [round]);
  /** The sentences being read; `picked` when they are the round picked for you (not a saved one). */
  const [reading, setReading] = useState<{ sentences: SentenceLike[]; picked: boolean } | null>(null);
  const [finished, setFinished] = useState(false);

  if (reading) {
    return (
      <Drill sentences={reading.sentences}
        onClose={() => {
          setReading(null);
          // Sentences already seen rest for a week; offer fresh ones.
          if (reading.picked) setRound((r) => r + 1);
        }}
        onDone={() => {
          setReading(null);
          if (!reading.picked) return;
          // The ones just read now rest for a week, so pick the next round.
          setFinished(true);
          setRound((r) => r + 1);
        }} />
    );
  }

  let start;
  if (picks.error) {
    start = (
      <div className="card st-error" role="alert">
        <p>The sentences didn't load. If this is the first time on this phone, connect to the internet once.</p>
        <button type="button" className="btn ink" onClick={picks.retry}>Try again</button>
      </div>
    );
  } else if (picks.loading || !picks.data) {
    start = <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Finding sentences at your level" />;
  } else if (!picks.data.length) {
    start = (
      <div className="card st-empty-card">
        <h2>No new sentences right now</h2>
        <p className="muted">
          Sentences unlock as you learn kana and kanji, and ones you have read rest for a week. Learn a few more and come back.
        </p>
        <Link className="btn ink" to="/session">Go to today's session</Link>
      </div>
    );
  } else {
    const n = picks.data.length;
    start = (
      <div className="card st-start">
        <h2 className="st-start-title">{finished ? 'Nice reading. Ready for more?' : 'Sentences at your level'}</h2>
        <p className="muted">
          {n} {n === 1 ? 'sentence' : 'sentences'} with at most one new word each. Read, listen, then say {n === 1 ? 'it' : 'them'} out loud.
        </p>
        <button type="button" className="btn primary block" onClick={() => setReading({ sentences: picks.data ?? [], picked: true })}>
          {finished ? `Read ${n} more` : 'Start reading'}<Icon name="arrow" size={18} />
        </button>
      </div>
    );
  }

  return (
    <Screen label="Read and shadow">
      <TopBar back="/learn" title="Read & shadow" />
      {start}
      <section className="st-section" aria-labelledby="saved-title">
        <h2 id="saved-title" className="label">Saved sentences</h2>
        <SavedList onRead={(s) => setReading({ sentences: [s], picked: false })} />
      </section>
    </Screen>
  );
}
