import { Link, useLocation, useParams } from 'react-router-dom';
import { Glyph } from '../components/Glyph.tsx';
import { SpeakButton } from '../components/SpeakButton.tsx';
import { CardStatus, ComingUp, MemoryHook, ReadingRow, spokenReading } from '../components/home/KanjiParts.tsx';
import { NEXT_UP, unitMeaning } from '../components/home/library.ts';
import { PracticePad } from '../components/home/PracticePad.tsx';
import { kanaToRomaji } from '../components/home/romaji.ts';
import { useLive } from '../components/home/useLive.ts';
import { Screen, TopBar } from '../components/ui.tsx';
import { loadCurriculum, loadKanji, loadMnemonics, loadRadicals, loadWordIndex } from '../lib/data.ts';
import { db, itemId } from '../lib/db.ts';
import { useSettings } from '../lib/hooks.ts';
import type { CurriculumUnit, KanjiEntry, MnemonicsFile, RadicalEntry, WordEntry } from '../lib/types.ts';
import { StrokeAnimation, StrokeOrderStrip, useStrokes } from '../writing/index.ts';
import '../components/home/home.css';
import '../components/home/library.css';

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
  /** Parts this kanji is built from, each with its own page. */
  components: Related[];
  /** For a part: kanji built with it, in teaching order. */
  usedIn: Related[];
  usedInCount: number;
  mnemonic?: string;
  /** Not yet learned and among the next few units of the course. */
  nextUp: boolean;
}

const USED_IN_SHOWN = 12;

async function loadDetail(char: string): Promise<Detail> {
  const [kanjiMap, radicalList, curriculum, mnemonics] = await Promise.all([
    loadKanji(),
    loadRadicals(),
    loadCurriculum(),
    // Hooks are a nice-to-have: a missing file must not hide the page.
    loadMnemonics().catch((): MnemonicsFile => ({})),
  ]);
  const radicals = new Map(radicalList.map((r) => [r.char, r]));
  const kanji = kanjiMap[char];
  const radical = kanji ? undefined : radicals.get(char);
  const type = kanji ? 'kanji' : 'radical';
  const unit = curriculum.units.find((u) => u.char === char && u.type === type);
  const related = (u: CurriculumUnit): Related => ({ char: u.char, meaning: unitMeaning(u, kanjiMap, radicals) });
  const unitOf = new Map(curriculum.units.map((u) => [u.char, u]));

  const components = (kanji?.components ?? []).flatMap((c) => {
    const u = unitOf.get(c);
    return u ? [related(u)] : [];
  });
  const users = radical || kanji
    ? curriculum.units.filter((u) => u.type === 'kanji' && kanjiMap[u.char]?.components.includes(char))
    : [];

  let nextUp = false;
  if (unit) {
    const introduced = new Set((await db.items.where('kind').anyOf('kanji', 'radical').primaryKeys()).map(String));
    const upcoming = curriculum.units
      .filter((u) => !introduced.has(itemId(u.type, u.char)))
      .sort((a, b) => a.index - b.index)
      .slice(0, NEXT_UP);
    nextUp = upcoming.includes(unit);
  }

  return {
    char,
    kanji,
    radical,
    unit,
    components,
    usedIn: users.slice(0, USED_IN_SHOWN).map(related),
    usedInCount: users.length,
    mnemonic: mnemonics[char],
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

function Words({ ids, romaji }: { ids: readonly string[]; romaji: boolean }) {
  const words = useLive(async () => {
    const index = await loadWordIndex();
    return ids.flatMap((id) => index.get(id) ?? []);
  }, [ids.join(',')]);
  if (!ids.length) return null;
  return (
    <section className="kd-section" aria-labelledby="kd-words-title">
      <h2 id="kd-words-title" className="hm-section-title">Words with this kanji</h2>
      {words.status === 'loading' && <div className="hm-skeleton kd-words-skeleton" aria-hidden="true" />}
      {words.status === 'error' && <p className="muted">The word list didn't load. It'll show once the app has finished downloading.</p>}
      {words.status === 'ready' && (
        <ul className="card kd-words">
          {words.value.map((w: WordEntry) => (
            <li key={w.id}>
              <div className="kd-word-text">
                <span className="kd-word-written" lang="ja">{w.written}</span>
                <span className="kd-word-kana" lang="ja">
                  {w.kana}{romaji && <span className="kd-romaji"> {kanaToRomaji(w.kana)}</span>}
                </span>
                <span className="kd-word-meaning">{w.meanings.slice(0, 2).join(', ')}</span>
              </div>
              <SpeakButton text={w.kana} compact label={`Listen to ${w.written}`} />
            </li>
          ))}
        </ul>
      )}
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

function Practice({ char }: { char: string }) {
  const { strokes } = useStrokes(char);
  if (!strokes) return null;
  return (
    <section className="kd-section" aria-labelledby="kd-practice-title">
      <h2 id="kd-practice-title" className="hm-section-title">Practice writing</h2>
      <p className="hm-hint">Just practice: nothing here is graded.</p>
      <PracticePad key={char} strokes={strokes} label={char} />
    </section>
  );
}

export default function KanjiDetail() {
  const char = useParams().char ?? '';
  const location = useLocation();
  const settings = useSettings();
  const detail = useLive(() => loadDetail(char), [char]);
  // A live query keeps its last result until the next one arrives, so moving
  // from one kanji to another must not show (or "Learn this now") the old one.
  const d = detail.status === 'ready' && detail.value.char === char ? detail.value : undefined;
  const kind = d?.radical ? 'radical' : 'kanji';
  const id = itemId(kind, char);
  const mineLive = useLive(async () => ({
    id,
    item: await db.items.get(id),
    cards: await db.cards.where('itemId').equals(id).toArray(),
  }), [id]);
  const mine = mineLive.status === 'ready' && mineLive.value.id === id ? mineLive.value : undefined;
  const item = mine?.item;

  // Opened from inside the app → go back where we came from; opened directly → the library.
  const back = location.key === 'default' ? '/kanji' : true;

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
              <p className="muted">Issho teaches the 2,136 everyday (jōyō) kanji and the parts they're built from.</p>
              <Link to="/kanji" className="btn secondary small">Open the kanji library</Link>
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
      <TopBar back={back} title={<span className="kd-topbar">{kanji ? 'Kanji' : 'Part (radical)'}</span>} />

      <section className="card kd-hero">
        <div className="kd-glyph"><Glyph char={char} size={104} /></div>
        <div className="kd-hero-text">
          <h1 className="kd-meaning">{title}</h1>
          {meanings.length > 1 && <p className="muted kd-also">{meanings.slice(1).join(', ')}</p>}
          {radical && (
            <p className="muted kd-also">
              Means “{radical.meaning}”
              {radical.variantOf && <> · a short form of <Link to={`/kanji/${encodeURIComponent(radical.variantOf)}`} lang="ja">{radical.variantOf}</Link></>}
            </p>
          )}
          {kanji && (
            <dl className="kd-readings">
              <ReadingRow label="KUN" readings={kanji.kun.slice(0, 4)} romaji={settings.romaji} />
              <ReadingRow label="ON" readings={kanji.on.slice(0, 3)} romaji={settings.romaji} />
            </dl>
          )}
          {listen && <SpeakButton text={listen} />}
        </div>
      </section>

      {mine && (item
        ? <CardStatus item={item} cards={mine.cards} />
        : unit && <ComingUp unit={unit} nextUp={d.nextUp} />)}

      <StrokeOrder char={char} />

      {mine && <MemoryHook key={char} item={item} stock={d.mnemonic} />}

      {d.components.length > 0 && (
        <section className="kd-section" aria-labelledby="kd-parts-title">
          <h2 id="kd-parts-title" className="hm-section-title">Built from</h2>
          <RelatedGrid items={d.components} />
        </section>
      )}

      {unit && unit.type === 'kanji' && <Words ids={unit.words} romaji={settings.romaji} />}

      {d.usedInCount > 0 && (
        <section className="kd-section" aria-labelledby="kd-used-title">
          <h2 id="kd-used-title" className="hm-section-title">
            Part of {d.usedInCount} kanji
            {d.usedInCount > d.usedIn.length && <span className="kd-first"> · first {d.usedIn.length}</span>}
          </h2>
          <RelatedGrid items={d.usedIn} />
        </section>
      )}

      <Practice char={char} />
    </Screen>
  );
}
