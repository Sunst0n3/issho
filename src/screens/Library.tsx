import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigationType, useParams } from 'react-router-dom';
import { Glyph } from '../components/Glyph.tsx';
import { Segmented } from '../components/home/controls.tsx';
import { percent, plural } from '../components/home/labels.ts';
import {
  loadKanjiLibrary,
  loadStoryShelves,
  loadWordLibrary,
  matchesWord,
  wordSpeechText,
  type KanjiState,
  type KanjiTileView,
  type StoryView,
  type WordView,
} from '../components/home/library.ts';
import { useLive } from '../components/home/useLive.ts';
import { AudioButton } from '../components/study/AudioButton.tsx';
import { PitchLine } from '../components/study/PitchLine.tsx';
import { Icon, Ruby, Screen } from '../components/ui.tsx';
import { loadAccent } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { AccentFile } from '../lib/types.ts';
import '../components/home/home.css';
import '../components/home/library.css';

type Tab = 'kanji' | 'words' | 'stories';
const TABS: readonly Tab[] = ['kanji', 'words', 'stories'];

type Filter = 'all' | 'learned';
const FILTERS: readonly Filter[] = ['all', 'learned'];

/**
 * How the kanji tab was left: the filter, the chapters opened or closed, how many tiles each list
 * shows and the scroll position. Kept for the browser session, so going back from a kanji page
 * finds the library as it was.
 */
interface LibraryView {
  filter: Filter;
  open: Record<number, boolean>;
  limits: Record<string, number>;
  scrollY: number;
}

const VIEW_KEY = 'issho.library.view';

function readView(): LibraryView {
  const view: LibraryView = { filter: 'all', open: {}, limits: {}, scrollY: 0 };
  try {
    const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '{}') as Partial<LibraryView>;
    if (FILTERS.includes(saved.filter as Filter)) view.filter = saved.filter as Filter;
    if (saved.open && typeof saved.open === 'object') view.open = saved.open;
    if (saved.limits && typeof saved.limits === 'object') view.limits = saved.limits;
    if (typeof saved.scrollY === 'number' && saved.scrollY > 0) view.scrollY = saved.scrollY;
  } catch {
    // Storage blocked or garbled: start fresh.
  }
  return view;
}

function writeView(view: LibraryView) {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Storage blocked: the library just won't remember.
  }
}

/** Tiles rendered per chapter before "Show more". */
const PAGE = 180;
/** Words rendered before "Show more". */
const WORD_PAGE = 60;

const STATE_TEXT: Record<KanjiState, string> = {
  canWrite: 'can write',
  learning: 'learning',
  readingOnly: 'reading only',
  next: 'next up',
  locked: 'not learned yet',
};

const learnedState = (s: KanjiState) => s === 'canWrite' || s === 'learning' || s === 'readingOnly';

function Tile({ view }: { view: KanjiTileView }) {
  const { unit, meaning, state, pinned } = view;
  return (
    <Link to={`/kanji/${encodeURIComponent(unit.char)}`} className={`lib-tile ${state}${pinned ? ' pinned' : ''}`}
      aria-label={`${unit.char}, ${meaning || 'kanji'}, ${STATE_TEXT[state]}${pinned ? ', pinned' : ''}`}>
      <Glyph char={unit.char} size={28} />
      <span className="lib-meaning" aria-hidden="true">{meaning}</span>
      {pinned && <span className="lib-pin" aria-hidden="true"><Icon name="pen" size={12} /></span>}
    </Link>
  );
}

function TileGrid({ views, limit = PAGE, onMore }: { views: readonly KanjiTileView[]; limit?: number; onMore: (limit: number) => void }) {
  const shown = views.slice(0, limit);
  const rest = views.length - shown.length;
  return (
    <div className="lib-grid-wrap">
      <div className="lib-grid">
        {shown.map((v) => <Tile key={v.unit.char} view={v} />)}
      </div>
      {rest > 0 && (
        <button type="button" className="btn secondary small lib-more" onClick={() => onMore(limit + PAGE)}>
          Show {Math.min(rest, PAGE)} more
        </button>
      )}
    </div>
  );
}

function ChapterGroup({ chapter, views, open, onToggle, limit, onMore }: {
  chapter: number;
  views: readonly KanjiTileView[];
  open: boolean;
  onToggle: () => void;
  limit?: number;
  onMore: (limit: number) => void;
}) {
  const learned = views.filter((v) => learnedState(v.state)).length;
  const name = `Chapter ${chapter}`;
  const count = `${learned} of ${views.length} kanji`;
  const panelId = `lib-chapter-${chapter}`;
  return (
    <section className="lib-group">
      <h2 className="lib-group-head">
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle}
          aria-label={`${name}, ${count} learned`}>
          <span className="lib-group-name">{name}</span>
          <span className="lib-group-count">{count}</span>
          <span className={open ? 'lib-chevron open' : 'lib-chevron'} aria-hidden="true"><Icon name="forward" size={18} /></span>
        </button>
      </h2>
      {/* Closed groups render no tiles: thousands of them stay out of the page until asked for. */}
      <div id={panelId} hidden={!open}>
        {open && <TileGrid views={views} limit={limit} onMore={onMore} />}
      </div>
    </section>
  );
}

/** Scroll position of the page (the document scrolls, not the screen). */
const pageScroll = () => document.documentElement.scrollTop;

function KanjiTab() {
  const [saved] = useState(readView);
  const [filter, setFilter] = useState<Filter>(saved.filter);
  const [openChapters, setOpenChapters] = useState<Record<number, boolean>>(saved.open);
  const [limits, setLimits] = useState<Record<string, number>>(saved.limits);
  const lib = useLive(loadKanjiLibrary, []);
  const views = lib.status === 'ready' ? lib.value : undefined;
  const navigationType = useNavigationType();

  // Remember the view as it changes, and the scroll position once it's been restored.
  const view = useRef(saved);
  const tracking = useRef(false);
  useEffect(() => {
    view.current = { ...view.current, filter, open: openChapters, limits };
    writeView(view.current);
  }, [filter, openChapters, limits]);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (!tracking.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        view.current = { ...view.current, scrollY: pageScroll() };
        writeView(view.current);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  // Leaving: keep the position before the next page resets the scroll (layout
  // cleanups run before the next page's layout effects), and stop listening.
  useLayoutEffect(() => () => {
    if (!tracking.current) return;
    tracking.current = false;
    view.current = { ...view.current, scrollY: pageScroll() };
    writeView(view.current);
  }, []);
  // Coming back (Back, or a reload) puts the list where it was once the tiles are there.
  useLayoutEffect(() => {
    if (!views || tracking.current) return;
    if (navigationType === 'POP' && saved.scrollY) document.documentElement.scrollTop = saved.scrollY;
    tracking.current = true;
  }, [views, navigationType, saved]);

  const groups = useMemo(() => {
    if (!views) return [];
    const byChapter = new Map<number, KanjiTileView[]>();
    for (const v of views) {
      if (filter === 'learned' && !learnedState(v.state)) continue;
      const list = byChapter.get(v.unit.chapter) ?? [];
      list.push(v);
      byChapter.set(v.unit.chapter, list);
    }
    return [...byChapter.entries()].sort(([a], [b]) => a - b);
  }, [views, filter]);

  // The chapter being worked on starts open; the others stay closed until tapped.
  const currentChapter = views?.find((v) => !learnedState(v.state))?.unit.chapter ?? 1;
  const isOpen = (chapter: number) => openChapters[chapter] ?? chapter === currentChapter;
  const learnedCount = views?.filter((v) => learnedState(v.state)).length ?? 0;
  const writeCount = views?.filter((v) => v.state === 'canWrite').length ?? 0;

  return (
    <>
      {/* Counts per chapter only: no "N of 2,136" toward the whole list (the plan drops that framing). */}
      {views && (
        <p className="muted lib-summary">
          {plural(learnedCount, 'kanji', 'kanji')} learned so far, {writeCount.toLocaleString()} you can write
          from memory. Kanji past your handwriting list stay in reading practice.
        </p>
      )}
      <Segmented label="Show" value={filter} onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'learned', label: 'Learned' },
        ]} />

      {lib.status === 'loading' && <div className="lib-grid lib-skeleton" aria-busy="true" aria-label="Loading the library">
        {Array.from({ length: 24 }, (_, i) => <div key={i} className="hm-skeleton lib-tile-skeleton" />)}
      </div>}
      {lib.status === 'error' && (
        <section className="card hm-notice" role="alert">
          <h2 className="hm-notice-title">The library didn't load</h2>
          <p className="muted">The kanji data may still be downloading.</p>
          <button type="button" className="btn secondary small" onClick={lib.retry}>Try again</button>
        </section>
      )}

      {views && filter === 'learned' && groups.length === 0 && (
        <p className="empty">Nothing here yet. Kanji you meet in your sessions show up here.</p>
      )}
      {views && groups.map(([chapter, list]) => (
        <ChapterGroup key={`${filter}-${chapter}`} chapter={chapter} views={list}
          open={filter === 'learned' || isOpen(chapter)}
          onToggle={() => setOpenChapters((o) => ({ ...o, [chapter]: !isOpen(chapter) }))}
          limit={limits[`${filter}-${chapter}`]}
          onMore={(n) => setLimits((l) => ({ ...l, [`${filter}-${chapter}`]: n }))} />
      ))}
    </>
  );
}

function WordRow({ view, accent }: { view: WordView; accent: AccentFile }) {
  const { info } = view;
  const pitch = accent[info.ref];
  return (
    <li>
      <div className="kd-word-text">
        <span className="kd-word-written" lang="ja">{info.written}</span>
        {info.written !== info.kana && <span className="kd-word-kana" lang="ja">{info.kana}</span>}
        {pitch && <PitchLine accent={pitch} kana={info.kana} size="sm" />}
        <span className="kd-word-meaning">{info.en}</span>
      </div>
      <AudioButton source={{ ref: info.ref }} fallbackText={wordSpeechText(info)} compact label={`Listen to ${info.written}`} />
    </li>
  );
}

function WordsTab() {
  const words = useLive(async () => {
    const [list, accent] = await Promise.all([loadWordLibrary(), loadAccent().catch((): AccentFile => ({}))]);
    return { list, accent };
  }, []);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(WORD_PAGE);
  const shown = useMemo(
    () => (words.status === 'ready' ? words.value.list.filter((w) => matchesWord(w.info, query)) : []),
    [words, query],
  );
  return (
    <>
      <div className="hm-field">
        <label className="visually-hidden" htmlFor="lib-word-search">Search your words</label>
        <input id="lib-word-search" className="text-input" type="search" value={query} placeholder="Search in Japanese or English"
          autoComplete="off" autoCapitalize="none" onChange={(e) => { setQuery(e.target.value); setLimit(WORD_PAGE); }} />
      </div>
      {words.status === 'loading' && <div className="hm-skeleton kd-words-skeleton" aria-hidden="true" />}
      {words.status === 'error' && <p className="muted">The word list didn't load. It shows once the study data has downloaded.</p>}
      {words.status === 'ready' && (
        <>
          <p className="muted lib-summary" role="status">
            {query ? `${plural(shown.length, 'word')} found` : `${plural(words.value.list.length, 'word')} met so far, newest first`}
          </p>
          {shown.length > 0 ? (
            <ul className="card kd-words">
              {shown.slice(0, limit).map((w) => <WordRow key={w.info.ref} view={w} accent={words.value.accent} />)}
            </ul>
          ) : (
            <p className="empty">{query ? 'No word you know matches that.' : 'Words you meet in your sessions show up here.'}</p>
          )}
          {shown.length > limit && (
            <button type="button" className="btn secondary small lib-more" onClick={() => setLimit(limit + WORD_PAGE)}>
              Show {Math.min(shown.length - limit, WORD_PAGE)} more
            </button>
          )}
        </>
      )}
    </>
  );
}

const LEVEL_NAMES: Record<StoryView['story']['level'], string> = { start: 'Start', L0: 'Level 0', L1: 'Level 1' };

function StoryList({ title, hint, views, stretch = false }: { title: string; hint: string; views: readonly StoryView[]; stretch?: boolean }) {
  const show = useRubyShow();
  if (!views.length) return null;
  return (
    <section className="lib-group" aria-label={title}>
      <h2 className="lib-group-title">{title} <span className="muted">({views.length})</span></h2>
      <p className="hm-hint">{hint}</p>
      <ul className="lib-stories">
        {views.map(({ story, coverage, progress }) => (
          <li key={story.id}>
            <Link to={`/read/${encodeURIComponent(story.id)}`} className="lib-story">
              <span className="lib-story-text">
                <Ruby text={story.titleJp} show={show} className="lib-story-jp" />
                <span className="lib-story-title">{story.title}</span>
                <span className="hm-hint">
                  {LEVEL_NAMES[story.level]} · {story.chars.toLocaleString()} characters
                  {stretch ? ` · ${percent(coverage)} known · tap words for English` : ''}
                  {progress && progress.stage >= 3 ? ' · finished' : progress && progress.stage > 0 ? ' · in progress' : ''}
                </span>
              </span>
              <Icon name="forward" size={18} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StoriesTab() {
  const shelves = useLive(loadStoryShelves, []);
  if (shelves.status === 'loading') return <div className="hm-skeleton card-sized" aria-busy="true" aria-label="Loading stories" />;
  if (shelves.status === 'error') {
    return (
      <section className="card hm-notice" role="alert">
        <h2 className="hm-notice-title">The stories didn't load</h2>
        <button type="button" className="btn secondary small" onClick={shelves.retry}>Try again</button>
      </section>
    );
  }
  const { easy, stretch, read, later } = shelves.value;
  const none = !easy.length && !stretch.length && !read.length;
  return (
    <>
      {none && <p className="empty">Stories open up once you know enough of their words, at about 200 words.</p>}
      <StoryList title="Easy" hint="You know nearly every word: read while listening." views={easy} />
      <StoryList title="Stretch" hint="A few new words: tap a word for its English." views={stretch} stretch />
      <StoryList title="Read" hint="Stories you've started or finished." views={read} />
      {later > 0 && !none && (
        <p className="hm-hint">{plural(later, 'more story', 'more stories')} {later === 1 ? 'opens' : 'open'} up as you learn words.</p>
      )}
    </>
  );
}

const TAB_NAMES: Record<Tab, string> = { kanji: 'Kanji', words: 'Words', stories: 'Stories' };

export default function Library() {
  const param = useParams().tab;
  if (param !== undefined && !TABS.includes(param as Tab)) return <Navigate to="/library" replace />;
  const tab: Tab = (param as Tab | undefined) ?? 'kanji';

  return (
    <Screen tabs label="Library">
      <header>
        <p className="hm-eyebrow" lang="ja">書庫</p>
        <h1 className="hm-page-title">Library</h1>
      </header>
      <nav className="lib-tabs" aria-label="Library sections">
        {TABS.map((t) => (
          <Link key={t} to={`/library/${t}`} replace className={t === tab ? 'active' : undefined}
            aria-current={t === tab ? 'page' : undefined}>
            {TAB_NAMES[t]}
          </Link>
        ))}
        <Link to="/grammar">Grammar</Link>
      </nav>
      {tab === 'kanji' && <KanjiTab />}
      {tab === 'words' && <WordsTab />}
      {tab === 'stories' && <StoriesTab />}
    </Screen>
  );
}
