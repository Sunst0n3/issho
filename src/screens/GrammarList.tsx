// All grammar points, grouped by phase, with what is learned and what comes later.

import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { grammarGloss } from '../components/study/format.ts';
import { MixedText } from '../components/study/MixedText.tsx';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { loadGrammar } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { GrammarPoint } from '../lib/types.ts';
import { currentPhase } from '../srs/course.ts';
import '../components/study/study.css';

const PHASE_NAMES: Record<number, string> = {
  1: 'Kana & first words',
  2: 'Foundation',
  3: 'Reading for real',
  4: 'Real Japanese',
};

function Row({ point, learned, locked, show }: {
  point: GrammarPoint;
  learned: boolean;
  locked: boolean;
  /** Which readings to show, per the furigana setting. */
  show: ReturnType<typeof useRubyShow>;
}) {
  return (
    <li>
      <Link to={`/grammar/${encodeURIComponent(point.id)}`} className={locked ? 'st-grammar-row locked' : 'st-grammar-row'}>
        <span className="st-grammar-text">
          <span className="st-grammar-pattern"><Ruby text={point.pattern} show={show} /></span>
          {/* Hidden separators keep the link's name from running the pieces together. */}
          <span className="visually-hidden">, </span>
          <span className="st-grammar-title"><MixedText text={grammarGloss(point)} /></span>
        </span>
        {(learned || locked) && <span className="visually-hidden">, </span>}
        {learned ? (
          <span className="chip ai"><Icon name="check" size={12} strokeWidth={3} />Learned</span>
        ) : locked ? (
          <span className="chip st-chip-muted">Later</span>
        ) : null}
        <Icon name="forward" size={18} />
      </Link>
    </li>
  );
}

export default function GrammarList() {
  const show = useRubyShow();
  const data = useAsync(() => Promise.all([loadGrammar(), currentPhase()]), []);
  const introduced = useLiveQuery(
    async () => new Set((await db.items.where('kind').equals('grammar').primaryKeys()).map((id) => String(id).slice('grammar:'.length))),
    [],
  );

  let body;
  if (data.error) {
    body = (
      <div className="card st-error" role="alert">
        <p>The grammar lessons didn't load. If this is the first time on this phone, connect to the internet once.</p>
        <button type="button" className="btn ink" onClick={data.retry}>Try again</button>
      </div>
    );
  } else if (!data.data || !introduced) {
    body = <div className="st-skeleton st-skeleton-list" aria-busy="true" aria-label="Loading grammar" />;
  } else {
    const [points, phase] = data.data;
    if (!points.length) {
      body = <p className="empty">No grammar lessons on this phone yet.</p>;
    } else {
      const phases = [...new Set(points.map((p) => p.phase))].sort((a, b) => a - b);
      const learnedCount = points.filter((p) => introduced.has(p.id)).length;
      body = (
        <>
          <p className="muted">
            {learnedCount
              ? `${learnedCount} of ${points.length} learned. New points arrive in your sessions every other day.`
              : 'Grammar points arrive in your sessions every other day. You can read ahead any time.'}
          </p>
          {phases.map((ph) => (
            <section key={ph} className="st-section" aria-labelledby={`grammar-phase-${ph}`}>
              <h2 id={`grammar-phase-${ph}`} className="label">Phase {ph} · {PHASE_NAMES[ph]}</h2>
              <ul className="card st-grammar-list">
                {points.filter((p) => p.phase === ph).sort((a, b) => a.order - b.order).map((p) => (
                  <Row key={p.id} point={p} learned={introduced.has(p.id)} locked={!introduced.has(p.id) && p.phase > phase} show={show} />
                ))}
              </ul>
            </section>
          ))}
        </>
      );
    }
  }

  return (
    <Screen label="Grammar">
      <TopBar back="/learn" title="Grammar" />
      {body}
    </Screen>
  );
}
