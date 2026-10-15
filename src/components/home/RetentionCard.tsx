// Learn: real recall at about a week and about a month, by card family, over the last 30 days.
// Hidden until a family has enough reviews to say anything (10 per bucket).
import type { CardFamily } from '../../lib/types.ts';
import type { RetentionStat } from '../../srs/progress.ts';
import { percent } from './labels.ts';

const FAMILY_NAMES: Record<CardFamily, string> = {
  write: 'Handwriting',
  read: 'Reading',
  listen: 'Listening',
  produce: 'Saying and typing',
  grammar: 'Grammar',
};

export function hasRetention(stats: readonly RetentionStat[]): boolean {
  return stats.some((s) => s.week.rate !== null || s.month.rate !== null);
}

const cell = (rate: number | null) => (rate === null ? '–' : percent(rate));

export function RetentionCard({ stats }: { stats: readonly RetentionStat[] }) {
  if (!hasRetention(stats)) return null;
  const rows = stats.filter((s) => s.week.rate !== null || s.month.rate !== null);
  return (
    <section className="card hm-stat-card" aria-labelledby="retention-title">
      <h2 id="retention-title" className="hm-section-title">Real recall</h2>
      <p className="hm-hint">How often you remembered, when a card came back after about a week or a month.</p>
      <table className="hm-retention">
        <thead>
          <tr><th scope="col">Cards</th><th scope="col">~1 week</th><th scope="col">~1 month</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.family}>
              <th scope="row">{FAMILY_NAMES[s.family]}</th>
              <td>{cell(s.week.rate)}</td>
              <td>{cell(s.month.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
