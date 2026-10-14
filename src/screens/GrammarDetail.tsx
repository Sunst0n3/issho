// One grammar point: pattern, explanation, examples and ungraded practice.

import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DrillPractice } from '../components/study/DrillPractice.tsx';
import { GrammarExplainer } from '../components/study/learn/GrammarLesson.tsx';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Screen, TopBar } from '../components/ui.tsx';
import { db, itemId } from '../lib/db.ts';
import { loadGrammar } from '../lib/data.ts';
import { introduceItem } from '../srs/items.ts';
import '../components/study/study.css';

export default function GrammarDetail() {
  const { id = '' } = useParams();
  const grammar = useAsync(loadGrammar, []);
  const introduced = useLiveQuery(async () => (await db.items.get(itemId('grammar', id))) !== undefined, [id]);
  const [round, setRound] = useState(0);
  const [finished, setFinished] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addFailed, setAddFailed] = useState(false);

  const point = grammar.data?.find((g) => g.id === id);
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
  } else if (!point) {
    body = (
      <div className="card st-empty-card">
        <h2>Lesson not found</h2>
        <p className="muted">This grammar point isn't on this phone.</p>
        <Link className="btn ink" to="/grammar">All grammar</Link>
      </div>
    );
  } else {
    const learn = async () => {
      setAdding(true);
      setAddFailed(false);
      try {
        await introduceItem('grammar', point.id);
      } catch {
        setAddFailed(true);
      } finally {
        setAdding(false);
      }
    };
    body = (
      <>
        <GrammarExplainer point={point} />
        {introduced ? (
          <p className="chip ai st-center"><Icon name="check" size={12} strokeWidth={3} />In your reviews</p>
        ) : (
          <>
            <button type="button" className="btn primary block" onClick={() => void learn()} disabled={adding}>
              Learn this now
            </button>
            {addFailed && (
              <p className="feedback bad" role="alert">This phone couldn't save it to your reviews. Please try again.</p>
            )}
          </>
        )}
        {point.drills.length > 0 && (
          <section className="st-section" aria-label="Practice">
            {finished ? (
              <div className="card st-done-card">
                <p>That's all {point.drills.length}. Practice here isn't graded, so go again any time.</p>
                <button type="button" className="btn secondary" onClick={() => { setRound(round + 1); setFinished(false); }}>
                  Practice again
                </button>
              </div>
            ) : (
              <DrillPractice key={round} drills={point.drills} onDone={() => setFinished(true)} doneLabel="Finish" />
            )}
          </section>
        )}
      </>
    );
  }

  return (
    <Screen label={point ? `Grammar: ${point.title}` : 'Grammar'}>
      <TopBar back="/grammar" title="Grammar" />
      {body}
    </Screen>
  );
}
