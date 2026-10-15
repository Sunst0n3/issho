import { Link, useParams } from 'react-router-dom';
import { Glyph } from '../components/Glyph.tsx';
import { SpeakButton } from '../components/SpeakButton.tsx';
import { CardStatus, MemoryHook, PinToggle, ReadingRow, spokenReading } from '../components/home/KanjiParts.tsx';
import { NEXT_UP, wordSpeechText } from '../components/home/library.ts';
import { PartsPanel, partsOf, type PartView } from '../components/home/PartsPanel.tsx';
import { useLive } from '../components/home/useLive.ts';
import { AudioButton } from '../components/study/AudioButton.tsx';
import { PitchLine } from '../components/study/PitchLine.tsx';
import { Icon, Screen, TopBar } from '../components/ui.tsx';
import {
  loadAccent,
  loadCurriculum,
  loadKanji,
  loadMnemonics,
  loadRadicals,
  loadWords,
  loadWordInfo,
  type WordInfo,
} from '../lib/data.ts';
import { db, itemId } from '../lib/db.ts';
import type { AccentFile, AccentInfo, CurriculumUnit, KanjiEntry, MnemonicEntry, MnemonicsFile, RadicalEntry, WordEntry, WordRef } from '../lib/types.ts';
import { StrokeAnimation, StrokeOrderStrip, useStrokes } from '../writing/index.ts';
import '../components/home/home.css';
import '../components/home/library.css';

/** Related words shown besides the anchor and staged words. */
const RELATED_MAX = 8;
const USED_IN_SHOWN = 12;

type WordRole = 'anchor' | 'staged' | 'related';

interface WordLine {
  info: WordInfo;
  role: WordRole;
  known: boolean;
  accent?: AccentInfo;
}

interface Related {
  char: string;
  meaning: string;
}

interface Detail {
  /** The character this was loaded for. */
  char: string;
  kanji?: KanjiEntry;
  radical?: RadicalEntry;
  unit?: CurriculumUnit;
  parts: PartView[];
  /** For a named part: kanji built with it, in teaching order. */
  usedIn: Related[];
  usedInCount: number;
  words: WordLine[];
  mnemonic?: MnemonicEntry;
  /** Not yet learned and among the next few kanji of the course. */
  nextUp: boolean;
}

/** The ref a JMdict entry is learned under: its core word when it is one (one identity per word). */
const refOf = (w: WordEntry): WordRef => (w.core ? `core:${w.core}` : `word:${w.id}`);

/** pure: anchor, then staged words, then other words with the kanji — known ones first, then by frequency. */
export function wordLines(
  unit: CurriculumUnit | undefined,
  char: string,
  words: readonly WordEntry[],
  info: (ref: string) => WordInfo | undefined,
  known: ReadonlySet<string>,
  accent: AccentFile,
): WordLine[] {
  const lines: WordLine[] = [];
  const seen = new Set<string>();
  const add = (ref: string, role: WordRole) => {
    const w = info(ref);
    if (!w || seen.has(ref)) return;
    seen.add(ref);
    lines.push({ info: w, role, known: known.has(ref), accent: accent[ref] });
  };
  if (unit?.anchor) add(unit.anchor, 'anchor');
  for (const ref of unit?.staged ?? []) add(ref, 'staged');
  const related = words
    .filter((w) => w.kanji.includes(char) && !seen.has(refOf(w)))
    .sort((a, b) => Number(known.has(refOf(b))) - Number(known.has(refOf(a))) || a.freqRank - b.freqRank)
    .slice(0, RELATED_MAX);
  for (const w of related) add(refOf(w), 'related');
  return lines;
}

/** Old mnemonics files hold plain strings; v2 ones hold { meaning, sound }. */
function mnemonicOf(file: MnemonicsFile, char: string): MnemonicEntry | undefined {
  const value = file[char] as MnemonicEntry | string | undefined;
  if (!value) return undefined;
  return typeof value === 'string' ? { meaning: value } : value;
}

async function loadDetail(char: string): Promise<Detail> {
  const [kanjiMap, radicalList, curriculum, mnemonics, words, info, accent] = await Promise.all([
    loadKanji(),
    loadRadicals(),
    loadCurriculum(),
    // Hooks, words and accents are extras: a missing file must not hide the page.
    loadMnemonics().catch((): MnemonicsFile => ({})),
    loadWords().catch((): WordEntry[] => []),
    loadWordInfo().catch(() => () => undefined),
    loadAccent().catch((): AccentFile => ({})),
  ]);
  const radicals = new Map(radicalList.map((r) => [r.char, r]));
  const kanji = kanjiMap[char];
  const radical = kanji ? undefined : radicals.get(char);
  const unit = curriculum.units.find((u) => u.char === char);

  const users = curriculum.units
    .filter((u) => {
      const k = kanjiMap[u.char];
      return k && u.char !== char && (k.components.includes(char) || k.parts.includes(char));
    })
    .sort((a, b) => a.index - b.index);

  const introduced = await db.items.where('kind').anyOf('kanji', 'core', 'word').primaryKeys();
  const known = new Set(introduced.map(String));
  let nextUp = false;
  if (unit && !known.has(itemId('kanji', char))) {
    const upcoming = [...curriculum.units]
      .sort((a, b) => a.index - b.index)
      .filter((u) => !known.has(itemId('kanji', u.char)))
      .slice(0, NEXT_UP);
    nextUp = upcoming.includes(unit);
  }

  return {
    char,
    kanji,
    radical,
    unit,
    parts: kanji ? partsOf(kanji, kanjiMap, radicals) : [],
    usedIn: users.slice(0, USED_IN_SHOWN).map((u) => ({ char: u.char, meaning: kanjiMap[u.char]?.meanings[0] ?? '' })),
    usedInCount: users.length,
    words: kanji ? wordLines(unit, char, words, info, known, accent) : [],
    mnemonic: mnemonicOf(mnemonics, char),
    nextUp,
  };
}

function RelatedGrid({ items }: { items: readonly Related[] }) {
  return (
    <ul className="kd-related">
      {items.map((r) => (
        <li key={r.char}>
          <Link to={`/kanji/${encodeURIComponent(r.char)}`} className="lib-tile" aria-label={`${r.char}, ${r.meaning}`}>
            <Glyph char={r.char} size={28} />
            <span className="lib-meaning" aria-hidden="true">{r.meaning}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const ROLE_TEXT: Record<WordRole, string> = {
  anchor: 'Learned with this kanji',
  staged: 'Comes a few days after it',
  related: '',
};

function Words({ lines }: { lines: readonly WordLine[] }) {
  if (!lines.length) return null;
  return (
    <section className="kd-section" aria-labelledby="kd-words-title">
      <h2 id="kd-words-title" className="hm-section-title">Words with this kanji</h2>
      <ul className="card kd-words">
        {lines.map(({ info, role, known, accent }) => (
          <li key={info.ref} className={known ? 'known' : undefined}>
            <div className="kd-word-text">
              <span className="kd-word-written" lang="ja">{info.written}</span>
              <span className="kd-word-kana" lang="ja">{info.kana}</span>
              {accent && <PitchLine accent={accent} kana={info.kana} size="sm" />}
              <span className="kd-word-meaning">{info.en}</span>
              {(role !== 'related' || known) && (
                <span className="kd-word-role">{[ROLE_TEXT[role], known ? 'known' : ''].filter(Boolean).join(' · ')}</span>
              )}
            </div>
            <AudioButton source={{ ref: info.ref }} fallbackText={wordSpeechText(info)} compact label={`Listen to ${info.written}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StrokeOrder({ char }: { char: string }) {
  const { strokes, loading } = useStrokes(char);
  if (loading) return <div className="hm-skeleton kd-strokes-skeleton" aria-hidden="true" />;
  if (!strokes) return <p className="muted">No stroke order for this character yet.</p>;
  return (
    <section className="kd-section" aria-labelledby="kd-strokes-title">
      <h2 id="kd-strokes-title" className="hm-section-title">
        Stroke order · {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
      </h2>
      <div className="kd-anim"><StrokeAnimation strokes={strokes} label={char} /></div>
      <StrokeOrderStrip strokes={strokes} label={`Stroke order for ${char}`} />
    </section>
  );
}

export default function KanjiDetail() {
  const char = useParams().char ?? '';
  const detail = useLive(() => loadDetail(char), [char]);
  // A live query keeps its last result until the next one arrives, so moving
  // from one kanji to another must not show the old one.
  const d = detail.status === 'ready' && detail.value.char === char ? detail.value : undefined;
  const id = itemId('kanji', char);
  const mineLive = useLive(async () => ({
    id,
    item: await db.items.get(id),
    cards: await db.cards.where('itemId').equals(id).toArray(),
  }), [id]);
  const mine = mineLive.status === 'ready' && mineLive.value.id === id ? mineLive.value : undefined;
  const item = mine?.item;

  // Opened from inside the app, Back goes back where we came from; opened directly, to the library.
  const back = '/library';

  if (detail.status === 'loading' || (detail.status === 'ready' && !d)) {
    return (
      <Screen label="Kanji">
        <TopBar back={back} />
        <div className="hm-skeleton kd-hero-skeleton" aria-busy="true" aria-label="Loading" />
      </Screen>
    );
  }
  if (detail.status === 'error' || !d || (!d.kanji && !d.radical)) {
    return (
      <Screen label="Kanji">
        <TopBar back={back} />
        <section className="card hm-notice" role={detail.status === 'error' ? 'alert' : undefined}>
          {detail.status === 'error' ? (
            <>
              <h1 className="hm-notice-title">This page didn't load</h1>
              <p className="muted">The kanji data may still be downloading.</p>
              <button type="button" className="btn secondary small" onClick={detail.retry}>Try again</button>
            </>
          ) : (
            <>
              <h1 className="hm-notice-title"><span lang="ja">{char}</span> isn't in the course</h1>
              <p className="muted">Issho teaches the 2,136 everyday (jōyō) kanji and names the parts they're built from.</p>
              <Link to="/library" className="btn secondary small">Open the library</Link>
            </>
          )}
        </section>
      </Screen>
    );
  }

  const { kanji, radical, unit } = d;
  const meanings = kanji?.meanings ?? [];
  const title = kanji ? meanings[0] ?? char : radical?.name ?? char;
  const listen = kanji ? spokenReading(kanji.kun, kanji.on) : '';

  return (
    <Screen label={`${char}, ${title}`}>
      <TopBar back={back} heading={false} title={<span className="kd-topbar">{kanji ? 'Kanji' : 'Part'}</span>} />

      <section className="card kd-hero">
        <div className="kd-glyph"><Glyph char={char} size={104} /></div>
        <div className="kd-hero-text">
          <h1 className="kd-meaning">{title}</h1>
          {meanings.length > 1 && <p className="muted kd-also">{meanings.slice(1).join(', ')}</p>}
          {radical && (
            <p className="muted kd-also">
              Means “{radical.meaning}”
              {radical.variantOf && (
                <> · a form of{' '}
                  <Link to={`/kanji/${encodeURIComponent(radical.variantOf)}`} className="kd-variant" lang="ja">
                    {radical.variantOf}
                  </Link>
                </>
              )}
            </p>
          )}
          {kanji && (
            <dl className="kd-readings">
              <ReadingRow label="KUN" readings={kanji.kun.slice(0, 4)} />
              <ReadingRow label="ON" readings={kanji.on.slice(0, 3)} />
            </dl>
          )}
          <div className="kd-hero-tags">
            {kanji?.jlptOld !== undefined && <span className="chip ai">Old JLPT {kanji.jlptOld}</span>}
            {unit && <span className="chip shu">Chapter {unit.chapter}</span>}
          </div>
          {listen && <SpeakButton text={listen} />}
        </div>
      </section>

      {kanji && mine && (item
        ? <CardStatus item={item} cards={mine.cards} />
        : unit && (
          <section className="card kd-coming">
            <p>
              <strong>{d.nextUp ? 'Next up' : `Coming in chapter ${unit.chapter}`}</strong>
              <span className="muted"> · It arrives in a session, with its first word.</span>
            </p>
          </section>
        ))}

      {kanji && (
        <div className="kd-actions">
          <Link to={`/write/${encodeURIComponent(char)}`} className="btn secondary small">
            <Icon name="pen" size={18} />Practice writing
          </Link>
        </div>
      )}
      {kanji && item && <PinToggle item={item} />}

      {kanji && <PartsPanel parts={d.parts} />}

      {mine && <MemoryHook key={char} item={item} stock={d.mnemonic} />}

      <Words lines={d.words} />

      <StrokeOrder char={char} />

      {d.usedInCount > 0 && (
        <section className="kd-section" aria-labelledby="kd-used-title">
          <h2 id="kd-used-title" className="hm-section-title">
            Part of {d.usedInCount} kanji
            {d.usedInCount > d.usedIn.length && <span className="kd-first"> · first {d.usedIn.length}</span>}
          </h2>
          <RelatedGrid items={d.usedIn} />
        </section>
      )}
    </Screen>
  );
}
