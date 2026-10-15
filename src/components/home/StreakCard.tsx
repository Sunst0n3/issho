// Today: days studied this month, the longest streak, the current streak only while it is alive,
// and this week's days. Never a broken streak, never a count of days without study.
import type { HabitDayStatus, StreakV2 } from '../../srs/habits.ts';
import { dateOfKey, plural, streakText, WEEKDAYS_EN } from './labels.ts';

const STATUS_TEXT: Record<HabitDayStatus, string> = {
  goal: 'goal met',
  done: 'studied',
  rest: 'rest day',
  repaired: 'made up',
  travel: 'away',
  missed: 'no study',
  today: 'today',
  future: 'coming up',
  before: 'before you started',
};

/** A day of this week before the fresh start the learner chose. */
const BEFORE_FRESH_START = 'before your fresh start';

/** Spoken after "today, ". */
function todayText(info: StreakV2): string {
  if (info.todayGoal) return 'goal met';
  if (info.todayMinimum) return 'studied';
  return 'not studied yet';
}

/** pure: the visually hidden label of one day of the week, e.g. "Thursday: today, not studied yet". */
function dayStatusText(day: string, status: HabitDayStatus, info: StreakV2, beforeFreshStart = false): string {
  if (beforeFreshStart) return `${day}: ${BEFORE_FRESH_START}`;
  return `${day}: ${status === 'today' ? `today, ${todayText(info)}` : STATUS_TEXT[status]}`;
}

function title(info: StreakV2): string {
  return info.daysThisMonth > 0
    ? `${plural(info.daysThisMonth, 'day')} studied this month`
    : 'A new month of study';
}

function subline(info: StreakV2): string {
  const parts: string[] = [];
  if (info.longest > 0) parts.push(`longest ${plural(info.longest, 'day')}`);
  // The current streak only while it is alive: a broken one is never shown.
  if (info.alive && info.current > 0) parts.push(`${streakText(info.current)} now`);
  if (info.todayGoal) parts.push('goal met today');
  else if (info.todayMinimum) parts.push('today counts');
  return parts.length ? parts.join(' · ') : 'A few minutes a day builds it up';
}

/**
 * `freshStart`: the week view starts on that day (days before it in this week show as before).
 */
export function StreakCard({ info, freshStart }: { info: StreakV2; freshStart?: string }) {
  return (
    <section className="card streak-card" aria-labelledby="streak-title">
      <div className="streak-top">
        <span className="streak-badge" lang="ja" aria-hidden="true">続</span>
        <div className="streak-text">
          <h2 id="streak-title" className="streak-title">{title(info)}</h2>
          <p className="streak-sub">{subline(info)}</p>
        </div>
      </div>
      <ol className="streak-week" aria-label="This week">
        {info.week.map(({ date, status: raw }) => {
          const beforeFresh = Boolean(freshStart && date < freshStart && raw !== 'today' && raw !== 'before');
          const status: HabitDayStatus = beforeFresh ? 'before' : raw;
          const day = WEEKDAYS_EN[dateOfKey(date).getDay()];
          return (
            <li key={date} className={`streak-day ${status}`}>
              <span className="streak-dot" aria-hidden="true" />
              <span className="streak-letter" aria-hidden="true">{day[0]}</span>
              <span className="visually-hidden">{dayStatusText(day, status, info, beforeFresh)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
