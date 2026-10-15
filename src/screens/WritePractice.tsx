// Writing practice for one character (/write/:char), opened from a kanji's page or the kana chart. Never graded and
// no lists: once a day, a kana or kanji introduced before today gets one recall attempt from its prompt (it never adds
// a same-day retrieval for something just learned). After that, or for any other character, the stroke order and the
// guided pad.

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { clipRef } from '../../shared/voicevox.ts';
import { AudioButton } from '../components/study/AudioButton.tsx';
import { blankKanji, zeroWordReading } from '../components/study/cards/prepare.ts';
import { PracticePad } from '../components/study/PracticePad.tsx';
import { useStudyTimer } from '../components/study/time.ts';
import { useAsync } from '../components/study/useAsync.ts';
import { Glyph } from '../components/Glyph.tsx';
import { Screen, TopBar } from '../components/ui.tsx';
import { dayKey, db } from '../lib/db.ts';
import { loadCurriculum, loadKana, loadKanji, loadWordInfo, type WordInfo } from '../lib/data.ts';
import type { KanaEntry, KanjiEntry } from '../lib/types.ts';
import { useStrokes } from '../writing/useStrokes.ts';
import { WritingPad, type RecallResult } from '../writing/WritingPad.tsx';
import '../components/study/study.css';

const TRIED_PREFIX = 'issho.write.tried.';

/** The characters given their one recall attempt today (lost harmlessly when storage is). */
export function triedToday(day: string = dayKey()): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRIED_PREFIX + day) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function markTried(char: string, day: string = dayKey()): void {
  try {
    const tried = triedToday(day);
    tried.add(char);
    localStorage.setItem(TRIED_PREFIX + day, JSON.stringify([...tried]));
    // Older days' keys are of no use: tidy them away.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(TRIED_PREFIX) && key !== TRIED_PREFIX + day) localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: the attempt is simply offered again.
  }
}

interface CharInfo {
  char: string;
  kana?: KanaEntry;
  kanji?: KanjiEntry;
  anchor?: WordInfo;
  /** Introduced before today: one recall attempt a day is offered. */
  recallable: boolean;
}

async function loadChar(char: string): Promise<CharInfo | null> {
  const [kana, kanji] = await Promise.all([loadKana(), loadKanji()]);
  const k = kana.find((e) => e.char === char);
  const entry = kanji[char];
  if (!k && !entry) return null;
  const item = await db.items.get(`${k ? 'kana' : 'kanji'}:${char}`);
  const recallable = Boolean(item && dayKey(item.introducedAt) < dayKey());
  if (k) return { char, kana: k, recallable };
  const [curriculum, info] = await Promise.all([loadCurriculum(), loadWordInfo()]);
  const ref = curriculum.units.find((u) => u.char === char)?.anchor;
  const anchor = ref ? info(ref) : undefined;
  return { char, kanji: entry, ...(anchor && anchor.written.includes(char) ? { anchor } : {}), recallable };
}

function Prompt({ info }: { info: CharInfo }) {
  if (info.kana) {
    return (
      <div className="st-row st-center">
        <AudioButton source={{ ref: clipRef.kana(info.char) }} fallbackText={info.char} label="Play the sound" />
      </div>
    );
  }
  const k = info.kanji!;
  return (
    <div className="st-row st-center st-write-cue">
      <span className="st-write-keyword">{k.meanings[0]}</span>
      {info.anchor && <span lang="ja" className="st-write-blanked">· {blankKanji(info.anchor.written, info.char)}</span>}
      <span lang="ja" className="st-write-reading">{info.anchor ? info.anchor.kana : zeroWordReading(k)}</span>
    </div>
  );
}

function Recall({ info, onDone }: { info: CharInfo; onDone: () => void }) {
  const { strokes, loading, missing, error } = useStrokes(info.char);
  const [result, setResult] = useState<RecallResult | null>(null);
  const what = info.kana ? `the ${info.kana.script} you hear` : `the kanji for "${info.kanji!.meanings[0]}"`;
  return (
    <section className="st-write st-question" aria-label="Write it from memory">
      <div className="st-write-prompt">
        <h2 className="st-ask">Once from memory (not graded)</h2>
        <div className="st-write-target"><Prompt info={info} /></div>
      </div>
      {missing || error ? (
        <>
          <p className="card st-note" role="status">
            {error ? "The writing pad couldn't load. Check the connection and try again." : 'There is no stroke data for this character.'}
          </p>
          <button type="button" className="btn ink block" onClick={onDone}>Practise with the guide</button>
        </>
      ) : loading || !strokes ? (
        <div className="writing-pad st-skeleton" aria-busy="true" aria-label="Loading the writing pad" />
      ) : (
        <WritingPad strokes={strokes} mode="recall" label={what}
          onRecallDone={(r) => {
            markTried(info.char);
            setResult(r);
          }} />
      )}
      {result && (
        <>
          <p className={result.match.ok ? 'feedback good' : 'feedback bad'} role="status">
            {result.match.ok ? 'Written from memory.' : 'Compare your writing with the model.'}
          </p>
          <button type="button" className="btn ink block" onClick={onDone}>Practise with the guide</button>
        </>
      )}
    </section>
  );
}

export default function WritePractice() {
  useStudyTimer();
  const { char = '' } = useParams();
  const info = useAsync(() => loadChar(char), [char]);
  const [guided, setGuided] = useState(false);
  // Back to where it was opened from: a kana's chart or a kanji's page.
  const back = info.data?.kana ? '/kana' : `/kanji/${encodeURIComponent(char)}`;

  let body;
  if (info.loading) {
    body = <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the character" />;
  } else if (info.error) {
    body = (
      <div className="card st-error" role="alert">
        <p>The writing data didn't load. If this is the first time on this phone, connect to the internet once.</p>
        <button type="button" className="btn ink" onClick={info.retry}>Try again</button>
      </div>
    );
  } else if (!info.data) {
    body = (
      <div className="card st-empty-card">
        <Glyph char={char || '書'} size={56} />
        <h2>Nothing to write here</h2>
        <p className="muted">This character isn't in the course.</p>
      </div>
    );
  } else if (info.data.recallable && !guided && !triedToday().has(char)) {
    body = <Recall info={info.data} onDone={() => setGuided(true)} />;
  } else {
    const d = info.data;
    body = (
      <PracticePad key={char} char={char} ask={d.kana ? `Write the ${d.kana.script}` : 'Write the kanji'}
        target={<span lang="ja">{char}</span>} label={char} />
    );
  }

  return (
    <Screen label="Writing practice">
      <TopBar title="Writing practice" back={back} />
      {body}
    </Screen>
  );
}
