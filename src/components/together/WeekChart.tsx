import type { DayStats, MemberStats } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import { weekdayLong, weekdayShort } from './household.ts';

/** Paired bars of minutes studied per day (you vs. partner), with a table for screen readers. */
export function WeekChart({ me, partner, partnerName }: {
  me?: MemberStats;
  partner?: MemberStats;
  partnerName: string;
}) {
  // Days come from the server's DayStats.date, never from this phone's clock.
  const axis = (me?.days.length ? me.days : partner?.days ?? []).map((d) => d.date);
  const mine = new Map<string, DayStats>(me?.days.map((d) => [d.date, d]));
  const theirs = new Map<string, DayStats>(partner?.days.map((d) => [d.date, d]));
  const minutes = (m: Map<string, DayStats>, date: string) => Math.max(0, Math.round(m.get(date)?.studyMinutes ?? 0));
  const max = Math.max(1, ...axis.flatMap((date) => [minutes(mine, date), minutes(theirs, date)]));
  const bar = (who: 'you' | 'partner', value: number) => (
    <span className={value > 0 ? `tg-bar tg-${who}` : `tg-bar tg-${who} tg-empty`}
      style={value > 0 ? { height: `${Math.max(6, (value / max) * 100)}%` } : undefined} />
  );
  const today = dayKey();

  if (!axis.length) return <p className="muted tg-week-empty">Your week shows up here after your first session.</p>;

  return (
    <>
      <div className="tg-week-chart" aria-hidden="true">
        {axis.map((date) => (
          <div key={date} className={date === today ? 'tg-week-day tg-today' : 'tg-week-day'}>
            <div className="tg-week-bars">
              {bar('you', minutes(mine, date))}
              {partner && bar('partner', minutes(theirs, date))}
            </div>
            <span className="tg-week-label">{weekdayShort(date)}</span>
          </div>
        ))}
      </div>
      {/* A table can't shrink to the hidden 1 px box, and a long partner name would then
          widen the page; the div clips it instead. */}
      <div className="visually-hidden">
        <table>
          <caption>Minutes studied each day this week</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">You</th>
              {partner && <th scope="col">{partnerName}</th>}
            </tr>
          </thead>
          <tbody>
            {axis.map((date) => (
              <tr key={date}>
                <th scope="row">{weekdayLong(date)}</th>
                <td>{minutes(mine, date)} min</td>
                {partner && <td>{minutes(theirs, date)} min</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
