// After each teach batch: every kanji written from its write prompt, every sprint kana written from its sound and
// every core word said or typed from English (or, without a produce card, its meaning recalled from the audio), in a
// mixed order. Ungraded: a miss just shows the answer. Each prompt is the day's first retrieval of the item's
// production card.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { clipRef } from '../../../../shared/voicevox.ts';
import { loadCurriculum, loadKana, loadKanji, loadWordInfo, type WordInfo } from '../../../lib/data.ts';
import { db } from '../../../lib/db.ts';
import type { KanaEntry, KanjiEntry, RubyText } from '../../../lib/types.ts';
import { kanaMatches } from '../../../srs/answers.ts';
import { shuffle } from '../../../srs/random.ts';
import { spokenMatches } from '../../../speech/compare.ts';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { WritingPad, type RecallResult } from '../../../writing/WritingPad.tsx';
import { Icon } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { KanaInput } from '../cards/KanaInput.tsx';
import { KanaText } from '../cards/KanaText.tsx';
import { useAutoPlay } from '../cards/parts.tsx';
import { blankKanji, zeroWordReading } from '../cards/prepare.ts';
import { useFocusHeading, useScrollToTop } from '../focus.ts';
import type { LearnedItem } from '../session/machine.ts';
import { useAsync } from '../useAsync.ts';
import { useSpeech } from '../useSpeech.ts';
import { wordRuby } from './data.ts';

/** The framing line at the memory pass and the first check. */
export const SPACED_RECALL_LINE = 'Spaced recalls feel harder — that is why they stick.';

type Prompt =
  | { kind: 'kanji'; cardId: string; kanji: KanjiEntry; anchor?: WordInfo; blanked?: string; reading: string }
  | { kind: 'kana'; cardId: string; kana: KanaEntry }
  | { kind: 'say'; cardId: string; word: WordInfo; display: RubyText }
  | { kind: 'meaning'; cardId: string; word: WordInfo; display: RubyText };

async function loadPrompts(items: readonly LearnedItem[]): Promise<Prompt[]> {
  const [kanji, kana, curriculum, info] = await Promise.all([loadKanji(), loadKana(), loadCurriculum(), loadWordInfo()]);
  const out: Prompt[] = [];
  for (const item of items) {
    const cardId = item.memoryCardId;
    if (!cardId) continue;
    const { kind, key, itemId } = item.plan;
    if (kind === 'kanji' && kanji[key]) {
      const ref = item.plan.anchor ?? curriculum.units.find((u) => u.char === key)?.anchor ?? null;
      const anchor = ref ? info(ref) : undefined;
      out.push(anchor && anchor.written.includes(key)
        ? { kind: 'kanji', cardId, kanji: kanji[key], anchor, blanked: blankKanji(anchor.written, key), reading: anchor.kana }
        : { kind: 'kanji', cardId, kanji: kanji[key], reading: zeroWordReading(kanji[key]) });
    } else if (kind === 'kana') {
      const entry = kana.find((k) => k.char === key);
      if (entry) out.push({ kind: 'kana', cardId, kana: entry });
    } else if (kind === 'core') {
      const word = info(itemId);
      if (!word) continue;
      const spelled = Boolean((await db.items.get(itemId))?.spelledAt);
      const display = wordRuby(word, spelled);
      out.push(cardId.endsWith('|produce') ? { kind: 'say', cardId, word, display } : { kind: 'meaning', cardId, word, display });
    }
  }
  return out;
}

function WriteFromMemory({ char, ask, cue, label, onAnswered }: {
  char: string;
  ask: string;
  cue: ReactNode;
  label: string;
  onAnswered: () => void;
}) {
  const { strokes, loading } = useStrokes(char);
  const [result, setResult] = useState<RecallResult | null>(null);
  return (
    <section className="st-question st-write">
      <div className="st-write-prompt">
        <h2 className="st-ask">{ask}</h2>
        <div className="st-write-target">{cue}</div>
      </div>
      {loading || !strokes ? (
        loading ? <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" /> : (
          <button type="button" className="btn ink block" onClick={onAnswered}>I wrote it on paper</button>
        )
      ) : (
        <WritingPad strokes={strokes} mode="recall" label={label} disabled={result !== null}
          onRecallDone={(r) => {
            setResult(r);
            onAnswered();
          }} />
      )}
      {result && (
        <p className={result.match.ok ? 'feedback good' : 'feedback bad'} role="status">
          {result.match.ok ? 'Nice. That is it.' : <>Here it is: <span lang="ja">{char}</span>. Compare it with your writing.</>}
        </p>
      )}
    </section>
  );
}

function SayIt({ word, display, onAnswered }: { word: WordInfo; display: RubyText; onAnswered: () => void }) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<boolean | null>(null);
  const [notCaught, setNotCaught] = useState(false);
  const settle = (correct: boolean) => {
    if (result !== null) return;
    setResult(correct);
    onAnswered();
  };
  const check = (giveUp: boolean) => settle(!giveUp && kanaMatches(value, word.readings));
  // Saying it is the first choice; a transcript that doesn't match is not a miss (recognizers mishear), just a retry.
  const speech = useSpeech({
    onHeard: (heard) => (spokenMatches(heard, { written: word.written, readings: word.readings }) ? settle(true) : setNotCaught(true)),
    onFailed: () => setNotCaught(true),
  });
  return (
    <section className="st-question">
      <h2 className="st-ask">Say it, or type it</h2>
      <div className="card st-prompt">
        <p className="st-english">{word.en}</p>
        {result !== null && (
          <div className="st-reveal">
            <KanaText text={display} className="st-reveal-word" show="all" />
            <AudioButton compact source={{ ref: word.ref }} fallbackText={display} label="Listen" />
          </div>
        )}
      </div>
      {result === null ? (
        <>
          {speech.available && (
            <div className="st-speak">
              <button type="button" className={speech.listening ? 'btn primary block' : 'btn secondary block'} onClick={speech.toggle}
                aria-pressed={speech.listening}>
                <Icon name={speech.listening ? 'stop' : 'mic'} size={18} />{speech.listening ? 'Listening… tap to stop' : 'Say it'}
              </button>
              {notCaught && !speech.listening && <p className="st-retry" role="status">Didn't catch that. Try once more, or type it.</p>}
            </div>
          )}
          <KanaInput value={value} onChange={setValue} onSubmit={() => value.trim() && check(false)} label={speech.available ? 'Or type it' : 'Your answer'} />
          <div className="st-typed-actions">
            <button type="button" className="btn ghost small" onClick={() => check(true)}>Show me</button>
            <button type="button" className="btn ink small" disabled={!value.trim()} onClick={() => check(false)}>Check</button>
          </div>
        </>
      ) : (
        <p className={result ? 'feedback good' : 'feedback bad'} role="status">{result ? 'Yes.' : 'Here it is.'}</p>
      )}
    </section>
  );
}

function HearIt({ word, display, onAnswered }: { word: WordInfo; display: RubyText; onAnswered: () => void }) {
  const [revealed, setRevealed] = useState(false);
  useAutoPlay({ ref: word.ref }, { fallbackText: display });
  return (
    <section className="st-question">
      <h2 className="st-ask">What does it mean?</h2>
      <div className="card st-prompt">
        <AudioButton source={{ ref: word.ref }} fallbackText={display} label="Play again" />
        {revealed && (
          <div className="st-reveal">
            <KanaText text={display} className="st-reveal-word" show="all" />
            <p className="st-english">{word.en}</p>
          </div>
        )}
      </div>
      {!revealed && (
        <button type="button" className="btn ink block" onClick={() => { setRevealed(true); onAnswered(); }}>Show the meaning</button>
      )}
    </section>
  );
}

function KanaSound({ kana, onAnswered }: { kana: KanaEntry; onAnswered: () => void }) {
  useAutoPlay({ ref: clipRef.kana(kana.char) }, { fallbackText: kana.char });
  return (
    <WriteFromMemory char={kana.char} ask={`Write the ${kana.script} you hear`} label={`the ${kana.script} you hear`}
      cue={<AudioButton source={{ ref: clipRef.kana(kana.char) }} fallbackText={kana.char} label="Play the sound" />}
      onAnswered={onAnswered} />
  );
}

export function MemoryPass({ items, onRetrieved, mayRetrieve, onDone }: {
  items: readonly LearnedItem[];
  onRetrieved: (cardId: string) => void;
  /** Whether one more day-0 retrieval of the card is within the cap; a prompt over the cap is skipped. */
  mayRetrieve?: (cardId: string) => boolean;
  onDone: () => void;
}) {
  const ids = items.map((i) => i.plan.itemId).join(',');
  const loaded = useAsync(() => loadPrompts(items), [ids]);
  const prompts = useMemo(
    () => shuffle((loaded.data ?? []).filter((p) => mayRetrieve?.(p.cardId) ?? true)),
    // Fixed once loaded: a later change to the cap check must not reshuffle the pass.
    [loaded.data],
  );
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState(false);
  const reported = useRef(new Set<string>());
  const root = useRef<HTMLDivElement>(null);
  useScrollToTop(at);
  useFocusHeading(root, `${at}:${loaded.loading}`);

  if (loaded.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the memory pass" />;
  const prompt = prompts[at];
  if (!prompt) {
    return (
      <div className="st-learn" ref={root}>
        <p className="st-intro">Nothing to recall from this batch.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  const answer = () => {
    setAnswered(true);
    if (reported.current.has(prompt.cardId)) return;
    reported.current.add(prompt.cardId);
    onRetrieved(prompt.cardId);
  };
  const next = () => {
    setAnswered(false);
    if (at + 1 < prompts.length) setAt(at + 1);
    else onDone();
  };

  let body;
  switch (prompt.kind) {
    case 'kanji':
      body = (
        <WriteFromMemory char={prompt.kanji.char} ask="Write the kanji" label={`the kanji for "${prompt.kanji.meanings[0]}"`}
          cue={(
            <div className="st-row st-center st-write-cue">
              <span className="st-write-keyword">{prompt.kanji.meanings[0]}</span>
              {prompt.blanked && <span lang="ja" className="st-write-blanked">· {prompt.blanked}</span>}
              <span lang="ja" className="st-write-reading">{prompt.reading}</span>
            </div>
          )}
          onAnswered={answer} />
      );
      break;
    case 'kana':
      body = <KanaSound kana={prompt.kana} onAnswered={answer} />;
      break;
    case 'say':
      body = <SayIt word={prompt.word} display={prompt.display} onAnswered={answer} />;
      break;
    case 'meaning':
      body = <HearIt word={prompt.word} display={prompt.display} onAnswered={answer} />;
      break;
  }

  return (
    <div className="st-learn" ref={root}>
      {at === 0 && <p className="st-intro">{SPACED_RECALL_LINE}</p>}
      <p className="label">From memory {at + 1} / {prompts.length}</p>
      <div key={at}>{body}</div>
      {answered && (
        <div className="st-footer">
          <button type="button" className="btn ink st-grow" onClick={next}>{at + 1 < prompts.length ? 'Next' : 'Continue'}</button>
        </div>
      )}
    </div>
  );
}
