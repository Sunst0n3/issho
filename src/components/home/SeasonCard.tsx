// Learn: the season finale every 12 weeks — the season's numbers, and the can-do showcase in this
// week's Session C (or, without a partner connected, a passed can-do to run again).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { dayKey, db } from '../../lib/db.ts';
import { markMilestoneSeen, recordMilestone, SEASON_WEEKS } from '../../srs/milestones.ts';
import { Icon } from '../ui.tsx';
import { plural, shiftDay } from './labels.ts';

/** What one season (12 weeks) added: new kanji, words and grammar points, and the hours studied. */
export interface SeasonNumbers { kanji: number; words: number; grammar: number; hours: number }

/** pure: season n runs from the first study day + 12·(n − 1) weeks up to (not including) + 12·n weeks. */
export function seasonSpan(firstDay: string, season: number): { from: string; to: string } {
  const days = SEASON_WEEKS * 7;
  return { from: shiftDay(firstDay, days * (season - 1)), to: shiftDay(firstDay, days * season) };
}

/** The season's own numbers (not the whole course's): items introduced and hours studied within its span. */
export async function seasonNumbers(season: number, firstDay: string): Promise<SeasonNumbers> {
  const { from, to } = seasonSpan(firstDay, season);
  const inSpan = (day: string) => day >= from && day < to;
  const [items, days] = await Promise.all([
    db.items.where('kind').anyOf('kanji', 'core', 'word', 'grammar').toArray(),
    db.days.where('date').between(from, to, true, false).toArray(),
  ]);
  const counts: SeasonNumbers = { kanji: 0, words: 0, grammar: 0, hours: 0 };
  for (const item of items) {
    if (item.via === 'placement' || !inSpan(dayKey(item.introducedAt))) continue;
    if (item.kind === 'kanji') counts.kanji++;
    else if (item.kind === 'grammar') counts.grammar++;
    else counts.words++;
  }
  counts.hours = days.reduce((ms, d) => ms + (d.studyMs ?? 0) + (d.togetherMs ?? 0), 0) / 3_600_000;
  return counts;
}

export function SeasonCard({ season, counts, paired, passedCanDo }: {
  season: number;
  /** seasonNumbers: this season's, never the course totals. */
  counts: SeasonNumbers;
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
      <p className="hm-hint">This season:</p>
      <ul className="hm-season-numbers">
        <li><strong>{counts.kanji.toLocaleString()}</strong> new kanji</li>
        <li><strong>{counts.words.toLocaleString()}</strong> new {counts.words === 1 ? 'word' : 'words'}</li>
        <li><strong>{counts.grammar.toLocaleString()}</strong> new grammar {counts.grammar === 1 ? 'point' : 'points'}</li>
        <li><strong>{Math.round(counts.hours).toLocaleString()}</strong> {Math.round(counts.hours) === 1 ? 'hour' : 'hours'} of study</li>
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
