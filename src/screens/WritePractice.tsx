// Writing practice (Write tab): pick a learned kana or kanji and write it as
// often as you like. Nothing here is graded.

import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KanaTarget } from '../components/study/cards/KanaWriteCard.tsx';
import { cleanReading, sharedSoundRow } from '../components/study/format.ts';
import { PracticePad } from '../components/study/PracticePad.tsx';
import { useAsync } from '../components/study/useAsync.ts';
import { Glyph } from '../components/Glyph.tsx';
import { Icon, Screen } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { loadKana, loadKanji } from '../lib/data.ts';
import type { KanaEntry, KanjiEntry } from '../lib/types.ts';
import { isYoon } from '../srs/items.ts';
import '../components/study/study.css';

type SetName = 'recent' | 'work' | 'all';

const SETS: { name: SetName; label: string }[] = [
  { name: 'recent', label: 'Recent' },
  { name: 'work', label: 'Needs work' },
  { name: 'all', label: 'All learned' },
];

const RECENT_COUNT = 24;
const NEEDS_WORK_COUNT = 30;

interface WriteChar {
  char: string;
  kind: 'kana' | 'kanji';
  introducedAt: Date;
  lapses: number;
  stability: number;
}

/** Introduced kana (not yōon, which have no strokes of their own) and kanji, with how they are going. */
async function learnedChars(): Promise<WriteChar[]> {
  const [items, cards] = await Promise.all([
    db.items.where('kind').anyOf('kana', 'kanji').toArray(),
    db.cards.where('kind').anyOf('kana', 'kanji').toArray(),
  ]);
  const stats = new Map<string, { lapses: number; stability: number }>();
  for (const c of cards) {
    if (c.reps === 0) continue;
    const s = stats.get(c.itemId) ?? { lapses: 0, stability: Infinity };
    s.lapses += c.lapses;
    s.stability = Math.min(s.stability, c.stability);
    stats.set(c.itemId, s);
  }
  return items
    .filter((i) => !(i.kind === 'kana' && isYoon(i.key)))
    .map((i) => ({
      char: i.key,
      kind: i.kind as WriteChar['kind'],
      introducedAt: i.introducedAt,
      lapses: stats.get(i.id)?.lapses ?? 0,
      stability: stats.get(i.id)?.stability ?? Infinity,
    }));
}

function pickSet(all: readonly WriteChar[], set: SetName): WriteChar[] {
  const byNewest = [...all].sort((a, b) => b.introducedAt.getTime() - a.introducedAt.getTime());
  if (set === 'recent') return byNewest.slice(0, RECENT_COUNT);
  if (set === 'work') {
    return all
      .filter((c) => c.lapses > 0)
      .sort((a, b) => b.lapses - a.lapses || a.stability - b.stability)
      .slice(0, NEEDS_WORK_COUNT);
  }
  return [...all].sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime());
}

interface Info {
  kana: Map<string, KanaEntry>;
  kanji: Record<string, KanjiEntry>;
}

function gloss(c: WriteChar, info: Info): string {
  return c.kind === 'kanji' ? (info.kanji[c.char]?.meanings[0] ?? '') : (info.kana.get(c.char)?.romaji ?? '');
}

function prompt(c: WriteChar, info: Info) {
  if (c.kind === 'kana') {
    const k = info.kana.get(c.char);
    const row = k && sharedSoundRow(k, [...info.kana.values()]);
    return { ask: `Write the ${k?.script ?? 'kana'} for`, target: <KanaTarget romaji={k?.romaji ?? c.char} row={row} /> };
  }
  const k = info.kanji[c.char];
  const reading = k ? (k.kun[0] ? cleanReading(k.kun[0]) : k.on[0]) : undefined;
  return {
    ask: 'Write the kanji for',
    target: <>{k?.meanings[0] ?? c.char} {reading && <span lang="ja" className="st-write-reading">{reading}</span>}</>,
  };
}

function CharGrid({ title, chars, info, onPick }: { title: string; chars: WriteChar[]; info: Info; onPick: (c: WriteChar) => void }) {
  if (!chars.length) return null;
  return (
    <section className="st-section">
      <h2 className="label">{title}</h2>
      <ul className="st-char-grid">
        {chars.map((c) => {
          const meaning = gloss(c, info);
          return (
            <li key={c.char}>
              <button type="button" className="st-char" onClick={() => onPick(c)} aria-label={meaning ? `${c.char}, ${meaning}` : c.char}>
                <Glyph char={c.char} size={30} />
                <span className="st-char-meaning" aria-hidden="true">{meaning}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const EMPTY_SET: Record<SetName, string> = {
  recent: 'Nothing learned yet.',
  work: 'Nothing needs extra work right now. Characters you miss in reviews show up here.',
  all: 'Nothing learned yet.',
};

export default function WritePractice() {
  const chars = useLiveQuery(learnedChars, []);
  const info = useAsync(async (): Promise<Info> => {
    const [kana, kanji] = await Promise.all([loadKana(), loadKanji()]);
    return { kana: new Map(kana.map((k) => [k.char, k])), kanji };
  }, []);
  const [set, setSet] = useState<SetName>('recent');
  const [current, setCurrent] = useState<WriteChar | null>(null);

  const heading = (
    <header className="st-page-head">
      <p className="st-eyebrow" lang="ja">かく</p>
      <h1 className="st-page-title">Write</h1>
    </header>
  );

  if (info.error) {
    return (
      <Screen tabs label="Write">
        {heading}
        <div className="card st-error" role="alert">
          <p>The writing data didn't load. If this is the first time on this phone, connect to the internet once.</p>
          <button type="button" className="btn ink" onClick={info.retry}>Try again</button>
        </div>
      </Screen>
    );
  }
  if (!chars || !info.data) {
    return (
      <Screen tabs label="Write">
        {heading}
        <div className="st-skeleton st-skeleton-grid" aria-busy="true" aria-label="Loading your characters" />
      </Screen>
    );
  }
  const data = info.data;

  if (!chars.length) {
    return (
      <Screen tabs label="Write">
        {heading}
        <div className="card st-empty-card">
          <Glyph char="書" size={56} />
          <h2>Nothing to write yet</h2>
          <p className="muted">Kana and kanji appear here once you learn them in a session. Then you can practise them as often as you like.</p>
          <Link className="btn primary" to="/session">Start today's session</Link>
        </div>
      </Screen>
    );
  }

  const shown = pickSet(chars, set);

  if (current) {
    const { ask, target } = prompt(current, data);
    const pool = (shown.length > 1 ? shown : chars).filter((c) => c.char !== current.char);
    const nextRandom = () => setCurrent(pool[Math.floor(Math.random() * pool.length)]);
    // "Next random" sits in the top bar: a bottom button would cover the pad's tools above the tab bar.
    return (
      <Screen tabs label="Write">
        <div className="topbar">
          <button type="button" className="icon-btn" aria-label="Back to all characters" onClick={() => setCurrent(null)}>
            <Icon name="back" size={22} />
          </button>
          <div className="title">Practice</div>
          {pool.length > 0 && (
            <button type="button" className="btn secondary small" onClick={nextRandom}>
              Next random<Icon name="arrow" size={16} />
            </button>
          )}
        </div>
        <PracticePad key={current.char} char={current.char} ask={ask} target={target} />
      </Screen>
    );
  }

  return (
    <Screen tabs label="Write">
      {heading}
      <p className="muted">Pick a character to practise. Nothing here is graded.</p>
      <div className="segmented" role="radiogroup" aria-label="Which characters">
        {SETS.map((s) => (
          <button key={s.name} type="button" role="radio" aria-checked={set === s.name} onClick={() => setSet(s.name)}>
            {s.label}
          </button>
        ))}
      </div>
      {shown.length ? (
        <>
          <CharGrid title="Kanji" chars={shown.filter((c) => c.kind === 'kanji')} info={data} onPick={setCurrent} />
          <CharGrid title="Kana" chars={shown.filter((c) => c.kind === 'kana')} info={data} onPick={setCurrent} />
        </>
      ) : (
        <p className="empty">{EMPTY_SET[set]}</p>
      )}
    </Screen>
  );
}
