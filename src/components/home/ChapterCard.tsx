// Learn: the current chapter (15 kanji; chapter 0 is kana) with what it taught, and the same list
// for every earlier chapter. Lists load when opened.
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { loadGrammarIndex, loadKanji, loadWordInfo } from '../../lib/data.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import { chapterItems, type ChapterInfo } from '../../srs/milestones.ts';
import { Glyph } from '../Glyph.tsx';
import { Icon, ProgressBar } from '../ui.tsx';
import { useLive } from './useLive.ts';

export interface ChapterView {
  kanji: { char: string; meaning: string }[];
  words: { ref: string; written: string; kana: string; en: string }[];
  grammar: { id: string; pattern: string; title: string }[];
}

const firstGloss = (en: string) => en.split(/[;,(]/)[0].trim();

export async function loadChapterView(chapter: number): Promise<ChapterView> {
  const [items, kanji, wordInfo, grammar] = await Promise.all([
    chapterItems(chapter),
    loadKanji(),
    loadWordInfo(),
    loadGrammarIndex(),
  ]);
  return {
    kanji: items.kanji.map((char) => ({ char, meaning: kanji[char]?.meanings[0] ?? '' })),
    words: items.words.flatMap((ref) => {
      const w = wordInfo(ref);
      return w ? [{ ref, written: w.written, kana: w.kana, en: firstGloss(w.en) }] : [];
    }),
    grammar: items.grammar.flatMap((raw) => {
      const id = raw.startsWith('grammar:') ? raw.slice('grammar:'.length) : raw;
      const g = grammar.get(id);
      return g ? [{ id, pattern: rubyToPlain(g.pattern), title: g.title }] : [];
    }),
  };
}

function ChapterContents({ chapter }: { chapter: number }) {
  const view = useLive(() => loadChapterView(chapter), [chapter]);
  if (view.status === 'loading') return <div className="hm-skeleton hm-chapter-skeleton" aria-hidden="true" />;
  if (view.status === 'error') return <p className="muted">This list didn't load. It shows once the study data has downloaded.</p>;
  const { kanji, words, grammar } = view.value;
  if (!kanji.length && !words.length && !grammar.length) return <p className="hm-hint">Nothing yet in this chapter.</p>;
  return (
    <div className="hm-chapter-items">
      {kanji.length > 0 && (
        <div>
          <h4 className="hm-chapter-sub">Kanji</h4>
          <ul className="hm-chapter-kanji">
            {kanji.map((k) => (
              <li key={k.char}>
                <Link to={`/kanji/${encodeURIComponent(k.char)}`} className="lib-tile" aria-label={`${k.char}, ${k.meaning}`}>
                  <Glyph char={k.char} size={24} />
                  <span className="lib-meaning" aria-hidden="true">{k.meaning}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {words.length > 0 && (
        <div>
          <h4 className="hm-chapter-sub">Words</h4>
          <ul className="hm-chapter-words">
            {words.map((w) => (
              <li key={w.ref}>
                <span lang="ja" className="hm-chapter-jp">{w.written}</span>
                {w.written !== w.kana && <span lang="ja" className="hm-hint"> {w.kana}</span>}
                <span className="hm-chapter-en"> · {w.en}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {grammar.length > 0 && (
        <div>
          <h4 className="hm-chapter-sub">Grammar</h4>
          <ul className="hm-chapter-words">
            {grammar.map((g) => (
              <li key={g.id}>
                <Link to={`/grammar/${encodeURIComponent(g.id)}`}>
                  <span lang="ja" className="hm-chapter-jp">{g.pattern}</span>
                </Link>
                <span className="hm-chapter-en"> · {g.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Disclosure({ label, children, defaultOpen = false }: { label: string; children: () => ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="hm-disclosure">
      <button type="button" className="hm-disclosure-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className={open ? 'lib-chevron open' : 'lib-chevron'} aria-hidden="true"><Icon name="forward" size={16} /></span>
      </button>
      {/* The panel stays in the page (empty and hidden) so aria-controls always points somewhere. */}
      <div id={id} hidden={!open}>{open && children()}</div>
    </div>
  );
}

const chapterName = (n: number) => (n === 0 ? 'Chapter 0 · Kana' : `Chapter ${n}`);

export function ChapterCard({ info, theme }: { info: ChapterInfo; theme?: string }) {
  const earlier = Array.from({ length: info.chapter }, (_, i) => info.chapter - 1 - i);
  return (
    <section className="card hm-chapter" aria-labelledby="chapter-title">
      <p className="label">Your chapter</p>
      <h2 id="chapter-title" className="hm-notice-title">{info.text}</h2>
      {theme && <p className="hm-hint">Unit theme: {theme}</p>}
      <ProgressBar value={info.size ? info.done / info.size : 0} label={`Progress in ${chapterName(info.chapter)}`} />
      <Disclosure label="What this chapter taught">{() => <ChapterContents chapter={info.chapter} />}</Disclosure>
      {earlier.length > 0 && (
        <div className="hm-chapter-earlier">
          <h3 className="hm-section-title">Earlier chapters</h3>
          {earlier.map((n) => (
            <Disclosure key={n} label={chapterName(n)}>{() => <ChapterContents chapter={n} />}</Disclosure>
          ))}
        </div>
      )}
    </section>
  );
}
