// Learn: honest hours (solo plus together) against published study-hour benchmarks.
import { HOUR_BENCHMARKS } from '../../srs/milestones.ts';

function hoursText(h: number): string {
  if (h < 10) return `${Math.round(h * 10) / 10}`;
  return Math.round(h).toLocaleString();
}

function rangeText(from: number, to: number): string {
  return from === to ? `${from.toLocaleString()} h` : `${from.toLocaleString()}–${to.toLocaleString()} h`;
}

export function HoursCard({ hours }: { hours: number }) {
  return (
    <section className="card hm-stat-card" aria-labelledby="hours-title">
      <h2 id="hours-title" className="hm-section-title">Hours</h2>
      <p className="hm-stat-big">{hoursText(hours)} hours so far</p>
      <p className="hm-hint">Solo study plus your time together. Benchmarks for learners new to kanji:</p>
      <ul className="hm-benchmarks">
        {HOUR_BENCHMARKS.map((b) => {
          const share = Math.min(1, hours / b.from);
          return (
            <li key={b.id}>
              <span className="hm-benchmark-label">{b.label}</span>
              <span className="hm-benchmark-range">{rangeText(b.from, b.to)}</span>
              <span className="hm-benchmark-bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
