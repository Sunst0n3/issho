// The session's read & listen step, as the plan has it: sprint words (then any kana-only sentences), the day-14 Kana
// check, study sentences, or an Easy story (then at most one sentence).

import { useState } from 'react';
import { loadStories } from '../../lib/data.ts';
import type { ReadPlan } from '../../srs/planner.ts';
import { KanaCheck } from './learn/KanaCheck.tsx';
import { KanaWordsRead } from './KanaWordsRead.tsx';
import { ReadingDrill } from './ReadingDrill.tsx';
import { StoryReader } from './StoryReader.tsx';
import { useAsync } from './useAsync.ts';

type Part = 'kana-words' | 'kana-check' | 'story' | 'sentences';

/** pure: the parts of a read plan, in order. */
export function readParts(plan: ReadPlan): Part[] {
  const parts: Part[] = [];
  if (plan.kind === 'kana-check') return plan.kanaWords.length ? ['kana-check'] : [];
  if (plan.kind === 'kana-words' && plan.kanaWords.length) parts.push('kana-words');
  if (plan.kind === 'story' && plan.story) parts.push('story');
  if (plan.sentences.length) parts.push('sentences');
  return parts;
}

function Story({ plan, onDone }: { plan: NonNullable<ReadPlan['story']>; onDone: () => void }) {
  const story = useAsync(async () => (await loadStories()).find((s) => s.id === plan.storyId) ?? null, [plan.storyId]);
  if (story.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the story" />;
  if (!story.data) {
    return (
      <div className="st-reading">
        <p className="card st-note">This story isn't on this phone yet.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  return <StoryReader story={story.data} step={plan.step} onDone={onDone} />;
}

export function ReadBlock({ plan, todayReadCards, onRetrieved, mayRetrieve, onDone }: {
  plan: ReadPlan;
  /** Read cards of kana introduced today (sprint words count as their reading retrieval). */
  todayReadCards?: ReadonlySet<string>;
  onRetrieved?: (cardId: string) => void;
  mayRetrieve?: (cardId: string) => boolean;
  onDone: () => void;
}) {
  const [parts] = useState(() => readParts(plan));
  const [at, setAt] = useState(0);
  const part = parts[at];
  const next = () => (at + 1 < parts.length ? setAt(at + 1) : onDone());
  if (!part) {
    return (
      <div className="st-reading">
        <p className="card st-note">Nothing to read right now.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  switch (part) {
    case 'kana-words':
      return <KanaWordsRead key="kana" words={plan.kanaWords} todayReadCards={todayReadCards} onRetrieved={onRetrieved} mayRetrieve={mayRetrieve} onDone={next} />;
    case 'kana-check':
      return <KanaCheck key="check" words={plan.kanaWords} onDone={next} />;
    case 'story':
      return <Story key="story" plan={plan.story!} onDone={next} />;
    case 'sentences':
      return <ReadingDrill key="sentences" sentences={plan.sentences} onDone={next} />;
  }
}
