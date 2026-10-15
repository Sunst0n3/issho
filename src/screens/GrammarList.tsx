// Every grammar point, by the unit that teaches it, with what is learned.

import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { grammarGloss } from '../components/study/format.ts';
import { MixedText } from '../components/study/MixedText.tsx';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { loadGrammar, loadUnits } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { GrammarPoint, UnitSpec } from '../lib/types.ts';
import '../components/study/study.css';

const REGISTER_LABEL: Record<GrammarPoint['register'], string | undefined> = { polite: 'Polite', plain: 'Casual', both: undefined };

function Row({ point, learned, show }: {
  point: GrammarPoint;
  learned: boolean;
  /** Which readings to show, per the furigana setting. */
  show: ReturnType<typeof useRubyShow>;
}) {
  const register = REGISTER_LABEL[point.register];
  return (
    <li>
      <Link to={`/grammar/${encodeURIComponent(point.id)}`} className={learned ? 'st-grammar-row' : 'st-grammar-row locked'}>
        <span className="st-grammar-text">
          <span className="st-grammar-pattern"><Ruby text={point.pattern} show={show} /></span>
          {/* Hidden separators keep the link's name from running the pieces together. */}
          <span className="visually-hidden">, </span>
          <span className="st-grammar-title"><MixedText text={grammarGloss(point)} /></span>
        </span>
        {register && <><span className="visually-hidden">, </span><span className="chip st-chip-muted">{register}</span></>}
        {learned && (
          <>
            <span className="visually-hidden">, </span>
            <span className="chip ai"><Icon name="check" size={12} strokeWidth={3} />Learned</span>
          </>
        )}
        <Icon name="forward" size={18} />
      </Link>
    </li>
  );
}

/** pure: the points grouped by unit, in unit order, each group in teaching order. */
export function byUnit(points: readonly GrammarPoint[]): [number, GrammarPoint[]][] {
  const groups = new Map<number, GrammarPoint[]>();
  for (const p of [...points].sort((a, b) => a.order - b.order)) {
    const list = groups.get(p.unit);
    if (list) list.push(p);
    else groups.set(p.unit, [p]);
  }
  return [...groups].sort((a, b) => a[0] - b[0]);
}

export default function GrammarList() {
  const show = useRubyShow();
  const data = useAsync(async (): Promise<[GrammarPoint[], UnitSpec[]]> => Promise.all([loadGrammar(), loadUnits()]), []);
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
    const [points, units] = data.data;
    if (!points.length) {
      body = <p className="empty">No grammar lessons on this phone yet.</p>;
    } else {
      const learnedCount = points.filter((p) => introduced.has(p.id)).length;
      body = (
        <>
          <p className="muted">
            {learnedCount
              ? `${learnedCount} of ${points.length} learned. New points arrive in your sessions every other day.`
              : 'Grammar points arrive in your sessions every other day. You can read ahead any time.'}
          </p>
          {byUnit(points).map(([unit, list]) => {
            const spec = units.find((u) => u.id === unit);
            return (
              <section key={unit} className="st-section" aria-labelledby={`grammar-unit-${unit}`}>
                <h2 id={`grammar-unit-${unit}`} className="label">Unit {unit}{spec ? ` · ${spec.title}` : ''}</h2>
                <ul className="card st-grammar-list">
                  {list.map((p) => <Row key={p.id} point={p} learned={introduced.has(p.id)} show={show} />)}
                </ul>
              </section>
            );
          })}
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
