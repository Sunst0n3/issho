// Reading outside the session. /read: a few study sentences at your level (read, listen, guess, shadow) and the
// sentences you saved as cards. /read/:storyId: a story from the Library — a Stretch story with tap-for-English, or an
// Easy story read while listening.

import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { clipRef } from '../../shared/voicevox.ts';
import { AudioButton } from '../components/study/AudioButton.tsx';
import { StudyDisplayProvider } from '../components/study/DisplayProvider.tsx';
import { ReadingDrill, type PlannedSentence } from '../components/study/ReadingDrill.tsx';
import { SessionHeader } from '../components/study/SessionChrome.tsx';
import { StoryReader, type StoryStep } from '../components/study/StoryReader.tsx';
import { useStudyTimer } from '../components/study/time.ts';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { loadStories } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { SavedSentenceRecord, StoryEntry } from '../lib/types.ts';
import { EASY_COVERAGE, loadKnownWords, pickRead, storyCoverage } from '../srs/readListen.ts';
import '../components/study/study.css';

/** Minutes of sentences offered per round on /read. */
const ROUND_MINUTES = 5;

/** A Library story opens as an Easy read-while-listening when the learner knows ≥ 98 % of its words, else as a Stretch story. */
export function storyStepFor(story: StoryEntry, isKnown: (ref: string) => boolean): StoryStep {
  return storyCoverage(story, isKnown) >= EASY_COVERAGE ? 'rwl' : 'library';
}

function StoryScreen({ storyId }: { storyId: string }) {
  useStudyTimer('strand');
  const navigate = useNavigate();
  const data = useAsync(async () => {
    const [stories, known] = await Promise.all([loadStories(), loadKnownWords()]);
    const story = stories.find((s) => s.id === storyId);
    return story ? { story, step: storyStepFor(story, (ref) => known.isKnown(ref)) } : null;
  }, [storyId]);
  const back = () => navigate('/library/stories');
  if (data.loading) {
    return (
      <Screen label="Story">
        <TopBar back="/library/stories" title="Story" />
        <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the story" />
      </Screen>
    );
  }
  if (!data.data) {
    return (
      <Screen label="Story">
        <TopBar back="/library/stories" title="Story" />
        <div className="card st-empty-card">
          <h2>Story not found</h2>
          <p className="muted">{data.error ? "The stories didn't load. Connect to the internet once, then try again." : "This story isn't on this phone."}</p>
          <Link className="btn ink" to="/library/stories">All stories</Link>
        </div>
      </Screen>
    );
  }
  return (
    <Screen label={data.data.story.title}>
      <TopBar back="/library/stories" title={data.data.step === 'library' ? 'Stretch story' : 'Story'} />
      <StoryReader story={data.data.story} step={data.data.step} onDone={back} />
    </Screen>
  );
}

function SavedSentence({ s, onClose }: { s: SavedSentenceRecord; onClose: () => void }) {
  const show = useRubyShow();
  return (
    <div className="card st-start">
      <Ruby className="st-sentence" text={s.jp} show={show} />
      <p className="st-translation">{s.en}</p>
      <div className="st-row">
        <AudioButton source={{ ref: clipRef.sentence(s.id) }} fallbackText={s.jp} label="Listen" />
        <button type="button" className="btn ghost small" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function SavedList() {
  const saved = useLiveQuery(() => db.savedSentences.orderBy('savedAt').reverse().toArray(), []);
  const show = useRubyShow();
  const [open, setOpen] = useState<string | null>(null);
  if (!saved) return <div className="st-skeleton st-skeleton-list" aria-busy="true" aria-label="Loading saved sentences" />;
  if (!saved.length) {
    return <p className="empty">Save a sentence while reading and it comes back as a card with one word to fill in. Your saved sentences are listed here.</p>;
  }
  return (
    <ul className="card st-saved">
      {saved.map((s) => (
        <li key={s.id}>
          {open === s.id ? <SavedSentence s={s} onClose={() => setOpen(null)} /> : (
            <button type="button" className="st-saved-text" onClick={() => setOpen(s.id)}>
              <Ruby className="st-saved-jp" text={s.jp} show={show} />
              <span className="st-word-en">{s.en}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SentenceRound({ onClose, onDone, sentences }: {
  sentences: PlannedSentence[];
  onClose: () => void;
  onDone: () => void;
}) {
  useStudyTimer('strand');
  const [index, setIndex] = useState(0);
  const onProgress = useCallback((i: number) => setIndex(i), []);
  return (
    <Screen label="Read and listen">
      <SessionHeader progress={index / sentences.length} label={`Read ${index + 1} / ${sentences.length}`} onClose={onClose} title="Read & listen" />
      <ReadingDrill sentences={sentences} onProgress={onProgress} onDone={onDone} doneLabel="Finish" />
    </Screen>
  );
}

function ReadingHome() {
  const [round, setRound] = useState(0);
  const picks = useAsync(async () => (await pickRead({ minutes: ROUND_MINUTES })).sentences, [round]);
  const [reading, setReading] = useState(false);
  const [finished, setFinished] = useState(false);

  if (reading && picks.data?.length) {
    return (
      <SentenceRound sentences={picks.data}
        onClose={() => { setReading(false); setRound((r) => r + 1); }}
        onDone={() => { setReading(false); setFinished(true); setRound((r) => r + 1); }} />
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
        <p className="muted">Sentences open up as you learn words, and ones you have read rest for a week. Come back after a session or two.</p>
        <Link className="btn ink" to="/session">Go to today's session</Link>
      </div>
    );
  } else {
    const n = picks.data.length;
    start = (
      <div className="card st-start">
        <h2 className="st-start-title">{finished ? 'Nice reading. Ready for more?' : 'Sentences at your level'}</h2>
        <p className="muted">{n} {n === 1 ? 'sentence' : 'sentences'}, each with one recent word. Read aloud, listen, guess the word, then shadow.</p>
        <button type="button" className="btn primary block" onClick={() => setReading(true)}>
          {finished ? `Read ${n} more` : 'Start reading'}<Icon name="arrow" size={18} />
        </button>
      </div>
    );
  }

  return (
    <Screen label="Read">
      <TopBar back="/learn" title="Read" />
      {start}
      <Link className="card st-link" to="/library/stories">
        <Icon name="book" size={22} />
        <span><strong>Stories</strong><span className="muted">Easy stories to read while listening, and Stretch stories</span></span>
        <Icon name="forward" size={18} />
      </Link>
      <section className="st-section" aria-labelledby="saved-title">
        <h2 id="saved-title" className="label">Saved sentences</h2>
        <SavedList />
      </section>
    </Screen>
  );
}

export default function Reading() {
  const { storyId } = useParams();
  return <StudyDisplayProvider>{storyId ? <StoryScreen storyId={storyId} /> : <ReadingHome />}</StudyDisplayProvider>;
}
