// The two-minute fluency slot (never graded into FSRS): a timed re-read of a story, a 60-second speed round over
// well-known cards (read each aloud, tap Next), a numbers/time/price drill against the clock, or the pitch-ear drill.

import { useEffect, useRef, useState } from 'react';
import { dayKey, db } from '../../lib/db.ts';
import { loadStories } from '../../lib/data.ts';
import { Glyph } from '../Glyph.tsx';
import { Icon } from '../ui.tsx';
import type { FluencyPlan } from '../../srs/planner.ts';
import { kanaMatches } from '../../srs/answers.ts';
import { logFluency, numbersDrillToday, SPEED_ROUND_MS, speedRoundCards } from '../../srs/fluency.ts';
import type { NumberDrillItem } from '../../srs/numbersDrill.ts';
import { KanaInput } from './cards/KanaInput.tsx';
import { KanaText } from './cards/KanaText.tsx';
import { loadPrepareContext, prepareCard } from './cards/prepare.ts';
import type { PreparedCard } from './cards/types.ts';
import { PitchDrill } from './PitchDrill.tsx';
import { spokenNumberMatches } from './spokenNumbers.ts';
import { StoryReader } from './StoryReader.tsx';
import { useAsync } from './useAsync.ts';
import { useSpeech } from './useSpeech.ts';

/** The numbers drill runs against this clock too. */
export const NUMBERS_ROUND_MS = 60_000;

/** Seconds left on a countdown that starts on the first render. */
function useCountdown(ms: number, running: boolean): number {
  const [left, setLeft] = useState(ms);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!running) return;
    startedAt.current ??= Date.now();
    const tick = () => setLeft(Math.max(0, ms - (Date.now() - startedAt.current!)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [ms, running]);
  return left;
}

/** The Japanese a card asks about, to read aloud in the speed round. */
function SpeedPrompt({ prepared }: { prepared: PreparedCard }) {
  switch (prepared.view) {
    case 'kana-read': return <p className="st-big" lang="ja">{prepared.word?.kana ?? prepared.kana.char}</p>;
    case 'kana-rule': return <p className="st-big" lang="ja">{prepared.word.kana}</p>;
    case 'kanji-meaning': return <div className="st-big-glyph"><Glyph char={prepared.kanji.char} size={96} /></div>;
    case 'word-read': return <p className="st-big" lang="ja">{prepared.word.written}</p>;
    case 'listen': return <KanaText text={prepared.display} className="st-big" show="none" />;
    case 'grammar-comprehend': return <KanaText text={prepared.example.jp} className="st-sentence" />;
    default: return null;
  }
}

function SpeedRound({ cardIds, onDone }: { cardIds?: readonly string[]; onDone: () => void }) {
  const cards = useAsync(async () => {
    const ids = cardIds?.length ? [...cardIds] : await speedRoundCards();
    const ctx = await loadPrepareContext();
    const rows = await db.cards.bulkGet(ids);
    const prepared = await Promise.all(rows.map((c) => (c ? prepareCard(c, ctx) : Promise.resolve(null))));
    return prepared.filter((p): p is PreparedCard => p !== null && p.view !== 'produce');
  }, [cardIds?.join(',')]);
  const [started, setStarted] = useState(false);
  const [count, setCount] = useState(0);
  const left = useCountdown(SPEED_ROUND_MS, started);
  const logged = useRef(false);
  const list = cards.data ?? [];
  const over = started && (left <= 0 || count >= list.length);

  useEffect(() => {
    if (!over || logged.current) return;
    logged.current = true;
    void logFluency('speed', count).catch((e: unknown) => console.warn('could not log the round', e));
  }, [over, count]);

  if (cards.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the speed round" />;
  if (!list.length) {
    return (
      <div className="st-reading">
        <p className="card st-note">No speed round today.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  if (!started) {
    return (
      <div className="st-reading">
        <h2 className="st-ask">Speed round · 60 seconds</h2>
        <p className="card st-note">Read each one aloud as fast as you comfortably can, then tap Next. Nothing here is graded.</p>
        <div className="st-footer"><button type="button" className="btn primary st-grow" onClick={() => setStarted(true)}>Start</button></div>
      </div>
    );
  }
  if (over) {
    return (
      <div className="st-reading">
        <div className="feedback good st-feedback" role="status"><p className="st-fb-title">{count} read in a minute</p></div>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  return (
    <div className="st-reading">
      <p className="label st-speed-head"><span>{count} read</span><span>{Math.ceil(left / 1000)} s</span></p>
      <div className="card st-prompt"><SpeedPrompt prepared={list[count]} /></div>
      <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={() => setCount(count + 1)}>Next</button></div>
    </div>
  );
}

function NumbersRound({ onDone }: { onDone: () => void }) {
  const items = useAsync(() => numbersDrillToday(), [dayKey()]);
  const [started, setStarted] = useState(false);
  const [at, setAt] = useState(0);
  const [value, setValue] = useState('');
  /** What recognition heard for the current item when it wasn't the number ('' = nothing heard). */
  const [heard, setHeard] = useState<string | null>(null);
  const [correct, setCorrect] = useState(0);
  const [last, setLast] = useState<{ item: NumberDrillItem; ok: boolean } | null>(null);
  const left = useCountdown(NUMBERS_ROUND_MS, started);
  const logged = useRef(false);
  const list = items.data ?? [];
  const over = started && (left <= 0 || at >= list.length);
  const item = over ? undefined : list[at];

  /** Each item is answered once (a spoken result and a typed Enter can race). */
  const answeredAt = useRef(-1);
  const answer = (ok: boolean) => {
    if (!item || answeredAt.current === at) return;
    answeredAt.current = at;
    // Typed while the mic was still open: what it hears belongs to this item, not the next one.
    speech.cancel();
    if (ok) setCorrect((c) => c + 1);
    setLast({ item, ok });
    setValue('');
    setHeard(null);
    setAt(at + 1);
  };
  // A transcript that isn't the number is shown, not marked wrong: recognizers mishear numbers.
  const speech = useSpeech({
    onHeard: (transcript) => {
      if (item && spokenNumberMatches(transcript, item)) answer(true);
      else setHeard(transcript);
    },
    onFailed: () => setHeard(''),
  });

  useEffect(() => {
    if (!over || logged.current) return;
    logged.current = true;
    void logFluency('numbers', correct).catch((e: unknown) => console.warn('could not log the drill', e));
  }, [over, correct]);

  if (items.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the numbers drill" />;
  if (!started || !list.length) {
    return (
      <div className="st-reading">
        <h2 className="st-ask">Numbers, times and prices · 60 seconds</h2>
        <p className="card st-note">
          {list.length ? `${speech.available ? 'Say or type' : 'Type'} how each one is said, as many as you can.` : 'No numbers drill today.'}
        </p>
        <div className="st-footer">
          <button type="button" className="btn primary st-grow" onClick={() => (list.length ? setStarted(true) : onDone())}>
            {list.length ? 'Start' : 'Continue'}
          </button>
        </div>
      </div>
    );
  }
  if (over || !item) {
    return (
      <div className="st-reading">
        <div className="feedback good st-feedback" role="status"><p className="st-fb-title">{correct} right in a minute</p></div>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  const submit = () => {
    if (value.trim()) answer(kanaMatches(value, item.answers));
  };
  // One field for the whole round: remounting it per item would close the phone's keyboard.
  return (
    <div className="st-reading">
      <p className="label st-speed-head"><span>{correct} right</span><span>{Math.ceil(left / 1000)} s</span></p>
      <div className="card st-prompt"><p className="st-big">{item.prompt}</p></div>
      {speech.available && (
        <div className="st-speak">
          <button type="button" className={speech.listening ? 'btn primary block' : 'btn secondary block'} onClick={speech.toggle}
            aria-pressed={speech.listening}>
            <Icon name={speech.listening ? 'stop' : 'mic'} size={18} />{speech.listening ? 'Listening… tap to stop' : 'Say it'}
          </button>
          {heard !== null && !speech.listening && (
            <p className="st-retry" role="status">
              {heard ? <>Heard <span lang="ja">{heard}</span>. Try once more, or type it.</> : "Didn't catch that. Try once more, or type it."}
            </p>
          )}
        </div>
      )}
      <KanaInput value={value} onChange={setValue} onSubmit={submit} label={speech.available ? 'Or type how it is said' : 'How is it said?'} />
      {last && (
        <p className={last.ok ? 'st-verdict good' : 'st-verdict bad'} role="status">
          {last.ok ? 'Right' : <>{last.item.prompt}: <span lang="ja">{last.item.answers[0]}</span></>}
        </p>
      )}
      <div className="st-footer"><button type="button" className="btn ink st-grow" disabled={!value.trim()} onClick={submit}>Next</button></div>
    </div>
  );
}

function Reread({ storyId, onDone }: { storyId?: string; onDone: () => void }) {
  const story = useAsync(async () => (storyId ? (await loadStories()).find((s) => s.id === storyId) ?? null : null), [storyId]);
  if (story.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the story" />;
  if (!story.data) {
    return (
      <div className="st-reading">
        <p className="card st-note">The story for today's re-read isn't on this phone.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  return <StoryReader story={story.data} step="reread" onDone={onDone} />;
}

export function FluencySprint({ plan, onDone }: { plan: FluencyPlan; onDone: () => void }) {
  switch (plan.kind) {
    case 'reread': return <Reread storyId={plan.storyId} onDone={onDone} />;
    case 'speed': return <SpeedRound cardIds={plan.cardIds} onDone={onDone} />;
    case 'numbers': return <NumbersRound onDone={onDone} />;
    case 'pitch': return <PitchDrill onDone={onDone} />;
  }
}
