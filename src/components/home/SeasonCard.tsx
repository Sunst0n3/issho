// Learn: the season finale every 12 weeks — the season's numbers, and the can-do showcase in this
// week's Session C (or, without a partner connected, a passed can-do to run again).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { markMilestoneSeen, recordMilestone } from '../../srs/milestones.ts';
import type { LearnedCounts } from '../../srs/progress.ts';
import { Icon } from '../ui.tsx';
import { plural } from './labels.ts';

export function SeasonCard({ season, counts, hours, paired, passedCanDo }: {
  season: number;
  counts: Pick<LearnedCounts, 'kanjiCanWrite' | 'wordsLearned' | 'grammarLearned'>;
  hours: number;
  paired: boolean;
  /** A can-do already passed, to show off again when there is no Session C. */
  passedCanDo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    const id = `season:${season}`;
    try {
      await recordMilestone(id);
      await markMilestoneSeen(id);
    } catch {
      setBusy(false);
    }
  };
  return (
    <section className="card hm-season" aria-labelledby="season-title">
      <p className="label">Season {season} finale</p>
      <h2 id="season-title" className="hm-notice-title">Twelve weeks of Japanese</h2>
      <ul className="hm-season-numbers">
        <li><strong>{counts.kanjiCanWrite.toLocaleString()}</strong> kanji you can write</li>
        <li><strong>{counts.wordsLearned.toLocaleString()}</strong> words learned</li>
        <li><strong>{counts.grammarLearned.toLocaleString()}</strong> grammar points</li>
        <li><strong>{Math.round(hours).toLocaleString()}</strong> {Math.round(hours) === 1 ? 'hour' : 'hours'} of study</li>
      </ul>
      {paired ? (
        <Link to="/together/session/C" className="btn primary small">
          Show each other what you can do in Session C <Icon name="arrow" size={18} />
        </Link>
      ) : passedCanDo ? (
        <Link to={`/cando/${encodeURIComponent(passedCanDo)}`} className="btn primary small">
          Run a can-do you've passed <Icon name="arrow" size={18} />
        </Link>
      ) : (
        <p className="hm-hint">Celebrate it: {plural(12, 'week')} of showing up.</p>
      )}
      <button type="button" className="btn ghost small" onClick={() => void done()} disabled={busy}>Done celebrating</button>
    </section>
  );
}
