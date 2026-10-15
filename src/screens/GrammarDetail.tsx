// One grammar point: pattern, register, explanation, every example with audio, what it builds on and what it is
// easily confused with, and ungraded practice (taps and builds).

import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StudyDisplayProvider } from '../components/study/DisplayProvider.tsx';
import { DrillPractice } from '../components/study/DrillPractice.tsx';
import { grammarGloss } from '../components/study/format.ts';
import { BuildPractice, GrammarExplainer } from '../components/study/learn/GrammarLesson.tsx';
import { MixedText } from '../components/study/MixedText.tsx';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db, itemId } from '../lib/db.ts';
import { loadGrammarIndex } from '../lib/data.ts';
import type { GrammarPoint } from '../lib/types.ts';
import '../components/study/study.css';

function PointLinks({ title, ids, index }: { title: string; ids: readonly string[]; index: ReadonlyMap<string, GrammarPoint> }) {
  const points = ids.flatMap((id) => index.get(id) ?? []);
  if (!points.length) return null;
  return (
    <section className="st-section">
      <h3 className="label">{title}</h3>
      <ul className="card st-grammar-list">
        {points.map((p) => (
          <li key={p.id}>
            <Link to={`/grammar/${encodeURIComponent(p.id)}`} className="st-grammar-row">
              <span className="st-grammar-text">
                <span className="st-grammar-pattern"><Ruby text={p.pattern} show="all" /></span>
                <span className="visually-hidden">, </span>
                <span className="st-grammar-title"><MixedText text={grammarGloss(p)} /></span>
              </span>
              <Icon name="forward" size={18} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Practice = { kind: 'drills' } | { kind: 'build'; index: number } | null;

export default function GrammarDetail() {
  const { id = '' } = useParams();
  const grammar = useAsync(loadGrammarIndex, []);
  const introduced = useLiveQuery(async () => (await db.items.get(itemId('grammar', id))) !== undefined, [id]);
  const [practice, setPractice] = useState<Practice>(null);
  const [round, setRound] = useState(0);

  const point = grammar.data?.get(id);
  let body;
  if (grammar.error) {
    body = (
      <div className="card st-error" role="alert">
        <p>This lesson didn't load. If this is the first time on this phone, connect to the internet once.</p>
        <button type="button" className="btn ink" onClick={grammar.retry}>Try again</button>
      </div>
    );
  } else if (grammar.loading || introduced === undefined) {
    body = <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the lesson" />;
  } else if (!point || !grammar.data) {
    body = (
      <div className="card st-empty-card">
        <h2>Lesson not found</h2>
        <p className="muted">This grammar point isn't on this phone.</p>
        <Link className="btn ink" to="/grammar">All grammar</Link>
      </div>
    );
  } else {
    const index = grammar.data;
    const nextBuild = (i: number) => (i + 1 < point.buildItems.length ? setPractice({ kind: 'build', index: i + 1 }) : setPractice(null));
    body = (
      <>
        <GrammarExplainer point={point} />
        {introduced ? (
          <p className="chip ai st-center"><Icon name="check" size={12} strokeWidth={3} />In your reviews</p>
        ) : (
          <p className="chip st-chip-muted st-center">Comes in unit {point.unit}</p>
        )}
        <PointLinks title="Builds on" ids={point.prerequisites} index={index} />
        <PointLinks title="Easily confused with" ids={point.contrastWith} index={index} />
        <section className="st-section" aria-label="Practice">
          <h3 className="label">Practice (not graded)</h3>
          {practice?.kind === 'drills' && (
            <DrillPractice key={round} drills={point.drills} onDone={() => { setPractice(null); setRound(round + 1); }} doneLabel="Finish" />
          )}
          {practice?.kind === 'build' && (
            <BuildPractice key={`${round}-${practice.index}`} point={point} index={practice.index}
              doneLabel={practice.index + 1 < point.buildItems.length ? 'Next' : 'Finish'} onDone={() => nextBuild(practice.index)} />
          )}
          {!practice && (
            <div className="st-row">
              {point.drills.length > 0 && (
                <button type="button" className="btn secondary st-grow" onClick={() => setPractice({ kind: 'drills' })}>Fill the gaps</button>
              )}
              {point.buildItems.length > 0 && (
                <button type="button" className="btn secondary st-grow" onClick={() => setPractice({ kind: 'build', index: 0 })}>Build sentences</button>
              )}
            </div>
          )}
        </section>
      </>
    );
  }

  return (
    <StudyDisplayProvider>
      <Screen label={point ? `Grammar: ${point.title}` : 'Grammar'}>
        <TopBar back="/grammar" title="Grammar" />
        {body}
      </Screen>
    </StudyDisplayProvider>
  );
}
