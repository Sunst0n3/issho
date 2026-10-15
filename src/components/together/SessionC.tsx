// Session C (about 15 min): talk about the shared weekly story, the 4/3/2 retell, partner
// dictation (or the season showcase) and the weekly check-in.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { clipRef } from '../../../shared/voicevox.ts';
import { loadStories } from '../../lib/data.ts';
import type { CanDoRecord, StoryEntry } from '../../lib/types.ts';
import { CanDoCheckView } from '../../screens/CanDoCheck.tsx';
import { play, stopAudio } from '../../speech/audio.ts';
import { canDoStatus } from '../../srs/candos.ts';
import { SEASON_WEEKS } from '../../srs/milestones.ts';
import { useTogetherState } from '../../sync/together.ts';
import { Icon, Ruby } from '../ui.tsx';
import { CheckIn } from './CheckIn.tsx';
import { Dictation } from './Dictation.tsx';
import { Retell } from './Retell.tsx';
import type { SessionProps } from './SessionA.tsx';

export const STORY_PROMPTS = [
  'Who is in the story, and where are they?',
  'What happens, in order?',
  'What would you have done?',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function useStory(id: string | undefined): StoryEntry | null | undefined {
  const [story, setStory] = useState<StoryEntry | null>();
  useEffect(() => {
    if (!id) { setStory(null); return; }
    let alive = true;
    loadStories().then((all) => { if (alive) setStory(all.find((s) => s.id === id) ?? null); }, () => { if (alive) setStory(null); });
    return () => { alive = false; };
  }, [id]);
  return story;
}

export function SessionC(props: SessionProps) {
  const { run, plan, duo, me, partner, partnerProgress, online, units, weekPlan, ownSlots } = props;
  const story = useStory(plan.storyId);
  const { state } = useTogetherState();
  // The check-in starts from the slots the week plan uses: next week's when an earlier check-in this week already
  // planned them, else the household's, else this phone's own (not shared yet), not the defaults. Without the
  // together state (never synced) the household's slots are unknown, so an unchanged form posts none rather than
  // risk overwriting them.
  const slots = state?.nextSlots?.length ? state.nextSlots : state?.slots.length ? state.slots : ownSlots;
  const shared = state ? state.slots.length > 0 : true;
  switch (run.live.step) {
    case 'story':
      return <StoryTalk story={story} onNext={run.next} />;
    case 'retell':
      return <Retell topic={story?.title} duo={duo} me={me} partner={partner} run={run} />;
    case 'dictation':
      return <Dictation duo={duo} me={me} partner={partner} partnerRecentKanji={partnerProgress?.recentKanji ?? []} run={run} online={online} />;
    case 'showcase':
      return <Showcase units={units} onNext={run.next} />;
    case 'checkin':
      return (
        <CheckIn week={weekPlan.week} units={units} settledUnit={weekPlan.settledUnit}
          slots={slots} shared={shared} onSaved={run.next} />
      );
    default:
      return null;
  }
}

function StoryTalk({ story, onNext }: { story: StoryEntry | null | undefined; onNext(): void }) {
  const [playing, setPlaying] = useState(false);
  const stop = useRef<AbortController>();
  useEffect(() => () => { stop.current?.abort(); stopAudio(); }, []);

  const listen = async () => {
    if (!story) return;
    if (playing) {
      stop.current?.abort();
      stopAudio();
      setPlaying(false);
      return;
    }
    const abort = new AbortController();
    stop.current = abort;
    setPlaying(true);
    for (const [i, s] of story.sentences.entries()) {
      if (abort.signal.aborted) break;
      const result = await play({ ref: clipRef.story(story.id, i) }, { fallbackText: s.jp, phrases: s.phrases, signal: abort.signal });
      if (result.interrupted) break;
    }
    setPlaying(false);
  };

  return (
    <section className="card tg-story-talk">
      <p className="label">This week's story</p>
      {story === undefined && <div className="tg-skeleton-line" aria-busy="true" />}
      {story === null && <p className="muted">No shared story this week. Talk about your week instead.</p>}
      {story && (
        <>
          <h2>{story.title}</h2>
          <p className="tg-rp-jp" lang="ja"><Ruby text={story.titleJp} show="all" /></p>
          <div className="tg-button-row">
            <button type="button" className="btn secondary small" onClick={() => void listen()} aria-pressed={playing}>
              <Icon name={playing ? 'stop' : 'speaker'} size={16} />{playing ? 'Stop' : 'Listen again'}
            </button>
            <Link className="btn ghost small" to={`/read/${story.id}`}>Read it</Link>
          </div>
        </>
      )}
      <h3 className="label">Talk about it, in Japanese if you can</h3>
      <ol className="tg-story-prompts">{STORY_PROMPTS.map((q) => <li key={q}>{q}</li>)}</ol>
      <button type="button" className="btn primary block" onClick={onNext}>On to the retell</button>
    </section>
  );
}

/** The season finale: each partner re-runs one can-do they passed this season while the other watches. */
function Showcase({ units, onNext }: { units: SessionProps['units']; onNext(): void }) {
  const [passed, setPassed] = useState<CanDoRecord[]>();
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    let alive = true;
    const since = Date.now() - SEASON_WEEKS * 7 * DAY_MS;
    canDoStatus().then(
      (map) => { if (alive) setPassed([...map.values()].filter((r) => r.passedAt && r.passedAt.getTime() >= since)); },
      () => { if (alive) setPassed([]); },
    );
    return () => { alive = false; };
  }, []);
  const find = (id: string) => {
    for (const unit of units) {
      const canDo = unit.canDos.find((c) => c.id === id);
      if (canDo) return { unit, canDo };
    }
    return undefined;
  };

  const chosen = open ? find(open) : undefined;
  if (chosen) {
    // Showcase mode: a rehearsal for the partner to watch. Nothing is recorded or graded.
    return (
      <>
        <CanDoCheckView canDo={chosen.canDo} unit={chosen.unit} showcase onDone={() => setOpen(undefined)} />
        <button type="button" className="btn ghost block" onClick={() => setOpen(undefined)}>Back to the showcase</button>
      </>
    );
  }

  return (
    <section className="card tg-showcase">
      <p className="label">Season showcase</p>
      <h2>Show each other one thing you can do now</h2>
      <p className="muted">Pick a can-do you passed this season and run its check again while your partner watches. Nothing is scored.</p>
      {!passed ? <div className="tg-skeleton-line" aria-busy="true" /> : passed.length === 0 ? (
        <p className="muted">No can-do passed on this phone this season yet.</p>
      ) : (
        <ul className="tg-showcase-list">
          {passed.map((r) => (
            <li key={r.id}>
              <button type="button" className="tg-quiz-row" disabled={!find(r.id)} onClick={() => setOpen(r.id)}>
                <span>{find(r.id)?.canDo.text ?? r.id}</span>
                <Icon name="forward" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn primary block" onClick={onNext}>On to the check-in</button>
    </section>
  );
}
