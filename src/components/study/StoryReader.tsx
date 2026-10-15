// A graded story, in one of the ladder's steps:
//   rwl      read while listening: one clip per sentence, the current phrase highlighted, then the gist question;
//   listen   the text hidden, the audio only, then the gist question;
//   reread   the text alone against a timer: characters per minute, with the personal best;
//   library  a Stretch story to read freely, tapping a word for its English (shown in the footer, always on screen).
// Readings follow the learner's own furigana (each partner's phone shows different ones).

import { useEffect, useRef, useState, type RefObject } from 'react';
import { clipRef } from '../../../shared/voicevox.ts';
import { loadWordInfo, type WordInfo } from '../../lib/data.ts';
import { useFuriganaPolicy, useSettings } from '../../lib/hooks.ts';
import { isKanji } from '../../lib/ruby.ts';
import type { PreToken, StoryEntry } from '../../lib/types.ts';
import { logEncounters } from '../../srs/encounters.ts';
import { logFluency } from '../../srs/fluency.ts';
import { charsPerMinute, readingSpeed } from '../../srs/progress.ts';
import { recordStoryStep } from '../../srs/readListen.ts';
import { play, stopAudio } from '../../speech/audio.ts';
import { Icon } from '../ui.tsx';
import { ChoiceGrid } from './cards/parts.tsx';
import { useStudyDisplay } from './display.ts';
import { MixedText } from './MixedText.tsx';

export type StoryStep = 'rwl' | 'listen' | 'reread' | 'library';
export interface StoryResult { gistCorrect?: boolean; cpm?: number }

/** Automatic audio rate: slower for the first 90 course days. */
export function storyRate(audioRate: number | undefined, courseDay: number): number {
  return audioRate ?? (courseDay <= 90 ? 0.85 : 1);
}

const hasKanji = (s: string) => [...s].some(isKanji);

/** Scrolls `el` into view, smoothly unless the learner asked for less motion (jsdom has no scrollIntoView). */
function bringIntoView(el: Element | null | undefined, block: ScrollLogicalPosition): void {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  el?.scrollIntoView?.({ block, behavior: still ? 'auto' : 'smooth' });
}

function Token({ token, selected = false, onTap }: { token: PreToken; selected?: boolean; onTap?: () => void }) {
  const policy = useFuriganaPolicy();
  const ruby = token.r && hasKanji(token.s) && policy.forRef(token.ref, true, token.name === true);
  const text = ruby ? <ruby>{token.s}<rt>{token.r}</rt></ruby> : token.s;
  if (onTap && token.ref && token.k === 'c') {
    return (
      <button type="button" className={selected ? 'st-token selected' : 'st-token'} aria-pressed={selected} onClick={onTap}>{text}</button>
    );
  }
  return <>{text}</>;
}

/**
 * The story text, phrase by phrase; `current` marks the phrase being read out ([sentence, phrase]) and keeps it on
 * screen as the reading moves on. With `onTap`, content words are buttons; `selected` is the tapped one's key.
 */
export function StoryText({ story, current, selected, onTap }: {
  story: StoryEntry;
  current?: readonly [number, number] | null;
  /** `${sentence}:${token}` of the tapped word. */
  selected?: string | null;
  onTap?: (token: PreToken, key: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const at = current ? `${current[0]}:${current[1]}` : null;
  useEffect(() => {
    // 'nearest' does nothing while the phrase is in view; scroll-margin keeps it clear of the sticky header and footer.
    if (at) bringIntoView(root.current?.querySelector(`[data-phrase="${at}"]`), 'nearest');
  }, [at]);
  return (
    <div className={onTap ? 'st-story tappable' : 'st-story'} lang="ja" ref={root}>
      {story.sentences.map((sentence, n) => {
        const phrases = new Map<number, [PreToken, number][]>();
        sentence.tokens.forEach((t, i) => {
          const ph = t.ph ?? 0;
          const list = phrases.get(ph);
          if (list) list.push([t, i]);
          else phrases.set(ph, [[t, i]]);
        });
        return (
          <p key={n} className="st-story-sentence">
            {[...phrases].map(([ph, tokens]) => (
              <span key={ph} className={current && current[0] === n && current[1] === ph ? 'st-phrase current' : 'st-phrase'}
                data-phrase={`${n}:${ph}`}>
                {tokens.map(([t, i]) => {
                  const key = `${n}:${i}`;
                  return <Token key={i} token={t} selected={selected === key} onTap={onTap && (() => onTap(t, key))} />;
                })}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Gist({ story, onAnswer, sectionRef }: {
  story: StoryEntry;
  onAnswer: (correct: boolean) => void;
  sectionRef?: RefObject<HTMLElement>;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const answer = story.gist.options[story.gist.answer];
  return (
    <section className="st-question st-gist" ref={sectionRef}>
      <h2 className="st-ask" tabIndex={-1}><MixedText text={story.gist.q} /></h2>
      <ChoiceGrid options={story.gist.options} answer={answer} picked={picked}
        onPick={(option) => {
          if (picked !== null) return;
          setPicked(option);
          onAnswer(option === answer);
        }} />
    </section>
  );
}

/** Plays the sentences one after another from `from`, reporting each phrase; stops when unmounted or stopped. */
function usePlayStory(story: StoryEntry, rate: number) {
  const [current, setCurrent] = useState<[number, number] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const run = useRef(0);
  useEffect(() => () => {
    run.current++;
    stopAudio();
  }, []);

  const start = async (from = 0) => {
    const mine = ++run.current;
    setPlaying(true);
    for (let n = from; n < story.sentences.length; n++) {
      const sentence = story.sentences[n];
      setCurrent([n, 0]);
      const result = await play({ ref: clipRef.story(story.id, n) }, {
        rate,
        phrases: sentence.phrases,
        fallbackText: sentence.jp,
        onPhrase: (i) => {
          if (run.current === mine) setCurrent([n, i]);
        },
      });
      if (run.current !== mine) return;
      if (result.interrupted) {
        setPlaying(false);
        return;
      }
    }
    setPlaying(false);
    setCurrent(null);
    setFinished(true);
  };
  /** Pauses where it is: that phrase stays marked, and play resumes from its sentence. */
  const pause = () => {
    run.current++;
    stopAudio();
    setPlaying(false);
  };
  /** Ends the listening (the gist question is next): no phrase stays marked. */
  const stop = () => {
    pause();
    setCurrent(null);
  };
  return { current, playing, finished, start, pause, stop };
}

function ListenedStep({ story, step, rate, onDone }: { story: StoryEntry; step: 'rwl' | 'listen'; rate: number; onDone: (r: StoryResult) => void }) {
  const audio = usePlayStory(story, rate);
  const [stage, setStage] = useState<'read' | 'gist' | 'done'>('read');
  const [gist, setGist] = useState<boolean | null>(null);
  const question = useRef<HTMLElement>(null);
  const resume = audio.current?.[0] ?? 0;
  useEffect(() => {
    if (stage !== 'gist') return;
    // The footer that had focus is gone: the question takes it, and comes into view (on a phone it starts below the fold).
    question.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    bringIntoView(question.current, 'nearest');
  }, [stage]);
  useEffect(() => {
    // The Done footer that follows an answer would cover the last options: the marked answers stay in view.
    if (gist !== null) bringIntoView(question.current, 'nearest');
  }, [gist]);
  const finish = () => {
    setStage('done');
    void recordStoryStep(story.id, step, { gistCorrect: gist ?? undefined })
      .catch((e: unknown) => console.error('could not record the story step', e))
      .finally(() => onDone(gist === null ? {} : { gistCorrect: gist }));
  };
  return (
    <div className="st-reading">
      <header className="st-story-head">
        <p className="label">{step === 'rwl' ? 'Read while you listen' : 'Listen only'}</p>
        <h2 className="st-story-title">{story.title}</h2>
      </header>
      {step === 'rwl' ? <StoryText story={story} current={audio.current} /> : (
        <p className="card st-note st-listen-only">The text stays hidden this time: listen for the story.</p>
      )}
      {stage === 'read' && (
        <div className="st-footer">
          <button type="button" className="btn secondary" onClick={() => (audio.playing ? audio.pause() : void audio.start(audio.finished ? 0 : resume))}>
            <Icon name={audio.playing ? 'stop' : 'play'} size={18} />{audio.playing ? 'Pause' : audio.finished ? 'Play again' : resume ? 'Resume' : 'Play'}
          </button>
          <button type="button" className="btn ink st-grow" onClick={() => { audio.stop(); setStage('gist'); }}>
            {audio.finished ? 'Question' : 'I’ve finished'}
          </button>
        </div>
      )}
      {stage !== 'read' && <Gist story={story} onAnswer={setGist} sectionRef={question} />}
      {stage === 'gist' && gist !== null && (
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={finish}>Done</button></div>
      )}
    </div>
  );
}

function Reread({ story, onDone }: { story: StoryEntry; onDone: (r: StoryResult) => void }) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [cpm, setCpm] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);
  const stop = async () => {
    if (startedAt === null) return;
    const value = charsPerMinute(story.chars, performance.now() - startedAt);
    setCpm(value);
    // The best of every earlier timed re-read, as the Learn hub's speed card counts it (each story is re-read once).
    const before = await readingSpeed().catch(() => ({ best: null }));
    setBest(Math.max(value, before.best ?? 0));
    await Promise.all([
      logFluency('reread', value, story.id),
      recordStoryStep(story.id, 'reread', { cpm: value }),
    ]).catch((e: unknown) => console.error('could not record the re-read', e));
  };
  return (
    <div className="st-reading">
      <header className="st-story-head">
        <p className="label">Timed re-read</p>
        <h2 className="st-story-title">{story.title}</h2>
      </header>
      {startedAt === null ? (
        <p className="card st-note">Read the story at a comfortable pace, aloud or in your head. Tap Start, then Stop at the end.</p>
      ) : (
        <StoryText story={story} />
      )}
      {cpm !== null && (
        <div className="feedback good st-feedback" role="status">
          <p className="st-fb-title">{cpm} characters a minute</p>
          {best !== null && <p className="st-fb-note">{best > cpm ? `Your best: ${best}` : 'Your best yet'}</p>}
        </div>
      )}
      <div className="st-footer">
        {startedAt === null ? (
          <button type="button" className="btn primary st-grow" onClick={() => setStartedAt(performance.now())}>Start</button>
        ) : cpm === null ? (
          <button type="button" className="btn ink st-grow" onClick={() => void stop()}>Stop</button>
        ) : (
          <button type="button" className="btn ink st-grow" onClick={() => onDone({ cpm })}>Done</button>
        )}
      </div>
    </div>
  );
}

interface Gloss {
  key: string;
  token: PreToken;
  /** The word's entry once loaded; null when it has none. */
  info?: WordInfo | null;
}

/** The tapped word as a dictionary headword (行く いく, not the 行っ of 行って), then its English. */
function GlossCard({ gloss }: { gloss: Gloss }) {
  const written = gloss.info?.written ?? gloss.token.s;
  const kana = gloss.info ? gloss.info.kana : gloss.token.r;
  return (
    <div className="card st-gloss">
      <span lang="ja" className="st-word-written">{written}</span>
      {kana && kana !== written && <span lang="ja" className="st-word-kana">{kana}</span>}
      <span className="st-word-en">{gloss.info === undefined ? '…' : gloss.info?.en ?? 'No English for this word yet'}</span>
    </div>
  );
}

function Library({ story, onDone }: { story: StoryEntry; onDone: (r: StoryResult) => void }) {
  const [gloss, setGloss] = useState<Gloss | null>(null);
  const tap = (token: PreToken, key: string) => {
    // Tapping the same word again puts its English away.
    if (gloss?.key === key) {
      setGloss(null);
      return;
    }
    setGloss({ key, token });
    const settle = (info: WordInfo | null) => setGloss((g) => (g?.key === key ? { ...g, info } : g));
    void loadWordInfo().then((lookup) => settle((token.ref && lookup(token.ref)) || null), () => settle(null));
  };
  const done = () => {
    void logEncounters(story.refs, 'story').catch((e: unknown) => console.warn('could not log encounters', e));
    onDone({});
  };
  return (
    <div className="st-reading">
      <header className="st-story-head">
        <p className="label">Tap a word for its English</p>
        <h2 className="st-story-title">{story.title}</h2>
      </header>
      <StoryText story={story} selected={gloss?.key ?? null} onTap={tap} />
      {/* The English sits in the sticky footer, so it shows on screen wherever the word was. */}
      <div className="st-footer st-footer-stack">
        <div className="st-gloss-slot" role="status">{gloss && <GlossCard gloss={gloss} />}</div>
        <button type="button" className="btn ink st-grow" onClick={done}>Finish</button>
      </div>
    </div>
  );
}

export function StoryReader({ story, step, onDone }: { story: StoryEntry; step: StoryStep; onDone: (result: StoryResult) => void }) {
  const { audioRate } = useSettings();
  const { courseDay } = useStudyDisplay();
  const rate = storyRate(audioRate, courseDay);
  if (step === 'reread') return <Reread story={story} onDone={onDone} />;
  if (step === 'library') return <Library story={story} onDone={onDone} />;
  return <ListenedStep story={story} step={step} rate={rate} onDone={onDone} />;
}
