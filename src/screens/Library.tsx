import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Glyph } from '../components/Glyph.tsx';
import { Segmented } from '../components/home/controls.tsx';
import { PHASE_NAMES } from '../components/home/labels.ts';
import { loadLibrary, type UnitView } from '../components/home/library.ts';
import { useLive } from '../components/home/useLive.ts';
import { Icon, Screen, TopBar } from '../components/ui.tsx';
import type { Phase } from '../srs/course.ts';
import '../components/home/home.css';
import '../components/home/library.css';

type Filter = 'all' | 'learned' | 'work';

/** Tiles rendered per group before "Show more" (phase 4 alone has ~1,300 units). */
const PAGE = 180;

const STATE_TEXT = { learned: 'learned', next: 'next up', locked: 'not learned yet' } as const;

function Tile({ view }: { view: UnitView }) {
  const { unit, meaning, state, struggling } = view;
  const kind = unit.type === 'radical' ? 'part' : 'kanji';
  return (
    <Link to={`/kanji/${encodeURIComponent(unit.char)}`} className={`lib-tile ${state}${struggling ? ' struggling' : ''}`}
      aria-label={`${unit.char}, ${meaning || kind}, ${STATE_TEXT[state]}${struggling ? ', needs work' : ''}`}>
      <Glyph char={unit.char} size={28} />
      <span className="lib-meaning" aria-hidden="true">{meaning}</span>
      {struggling && <span className="lib-flag" aria-hidden="true" />}
    </Link>
  );
}

function TileGrid({ views }: { views: readonly UnitView[] }) {
  const [limit, setLimit] = useState(PAGE);
  const shown = views.slice(0, limit);
  const rest = views.length - shown.length;
  return (
    <div className="lib-grid-wrap">
      <div className="lib-grid">
        {shown.map((v) => <Tile key={`${v.unit.type}:${v.unit.char}`} view={v} />)}
      </div>
      {rest > 0 && (
        <button type="button" className="btn secondary small lib-more" onClick={() => setLimit((l) => l + PAGE)}>
          Show {Math.min(rest, PAGE)} more
        </button>
      )}
    </div>
  );
}

function PhaseGroup({ phase, views, open, onToggle }: {
  phase: number;
  views: readonly UnitView[];
  open: boolean;
  onToggle: () => void;
}) {
  const learned = views.filter((v) => v.state === 'learned').length;
  const panelId = `lib-phase-${phase}`;
  return (
    <section className="lib-group">
      <h2 className="lib-group-head">
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          <span className="lib-group-name">Phase {phase} · {PHASE_NAMES[phase as Phase]}</span>
          <span className="lib-group-count">{learned} / {views.length}</span>
          <span className={open ? 'lib-chevron open' : 'lib-chevron'} aria-hidden="true"><Icon name="forward" size={18} /></span>
        </button>
      </h2>
      {/* Closed groups render no tiles: thousands of them stay out of the page until asked for. */}
      <div id={panelId} hidden={!open}>
        {open && <TileGrid views={views} />}
      </div>
    </section>
  );
}

const EMPTY: Record<Exclude<Filter, 'all'>, string> = {
  learned: 'Nothing here yet. Kanji you meet in your sessions show up here.',
  work: 'Nothing needs work right now. Kanji you keep forgetting will show up here.',
};

export default function Library() {
  const [filter, setFilter] = useState<Filter>('all');
  const [openPhases, setOpenPhases] = useState<Record<number, boolean>>({});
  const lib = useLive(loadLibrary, []);
  const views = lib.status === 'ready' ? lib.value : undefined;

  const groups = useMemo(() => {
    if (!views) return [];
    const keep = (v: UnitView) =>
      filter === 'all' || (filter === 'learned' ? v.state === 'learned' : v.struggling);
    const byPhase = new Map<number, UnitView[]>();
    for (const v of views) {
      if (!keep(v)) continue;
      const list = byPhase.get(v.unit.phase) ?? [];
      list.push(v);
      byPhase.set(v.unit.phase, list);
    }
    return [...byPhase.entries()].sort(([a], [b]) => a - b);
  }, [views, filter]);

  // The phase being worked on starts open; the others stay closed until tapped.
  const currentPhase = views?.find((v) => v.state !== 'learned')?.unit.phase ?? 2;
  const isOpen = (phase: number) => openPhases[phase] ?? phase === currentPhase;
  const learnedKanji = views?.filter((v) => v.state === 'learned' && v.unit.type === 'kanji').length ?? 0;
  const totalKanji = views?.filter((v) => v.unit.type === 'kanji').length ?? 0;

  return (
    <Screen label="Kanji library">
      <TopBar back="/learn" title={<h1 className="lib-title">Kanji library</h1>} />
      {views && (
        <p className="muted lib-summary">
          {learnedKanji.toLocaleString()} of {totalKanji.toLocaleString()} kanji learned. Parts (radicals) come before the kanji that use them.
        </p>
      )}
      <Segmented label="Show" value={filter} onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'learned', label: 'Learned' },
          { value: 'work', label: 'Needs work' },
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

      {views && filter === 'all' && groups.map(([phase, list]) => (
        <PhaseGroup key={phase} phase={phase} views={list} open={isOpen(phase)}
          onToggle={() => setOpenPhases((o) => ({ ...o, [phase]: !isOpen(phase) }))} />
      ))}

      {views && filter !== 'all' && (groups.length === 0 ? (
        <p className="empty">{EMPTY[filter]}</p>
      ) : groups.map(([phase, list]) => (
        <section key={`${filter}-${phase}`} className="lib-group">
          <h2 className="lib-group-title">Phase {phase} · {PHASE_NAMES[phase as Phase]} <span className="muted">({list.length})</span></h2>
          <TileGrid views={list} />
        </section>
      )))}
    </Screen>
  );
}
