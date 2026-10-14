import type { DayStatus, StreakInfo } from '../../srs/progress.ts';
import { dateOfKey, plural, WEEKDAYS_EN } from './labels.ts';

const STATUS_TEXT: Record<DayStatus, string> = {
  done: 'studied',
  rest: 'rest day',
  missed: 'missed',
  today: 'today, not done yet',
  future: 'coming up',
};

function subline(info: StreakInfo): string {
  if (info.todayDone) return info.best > info.current ? `Done today · best ${info.best}` : 'Done today';
  if (info.current > 0) return 'Study today to keep it going';
  return info.best > 0 ? `Your best so far: ${plural(info.best, 'day')}` : 'One session a day builds it up';
}

export function StreakCard({ info }: { info: StreakInfo }) {
  return (
    <section className="card streak-card" aria-labelledby="streak-title">
      <div className="streak-top">
        <span className="streak-badge" lang="ja" aria-hidden="true">続</span>
        <div className="streak-text">
          <h2 id="streak-title" className="streak-title">
            {info.current > 0 ? `${plural(info.current, 'day')} streak` : 'Start your streak today'}
          </h2>
          <p className="streak-sub">{subline(info)}</p>
        </div>
      </div>
      <ol className="streak-week" aria-label="This week">
        {info.week.map(({ date, status }) => {
          const day = WEEKDAYS_EN[dateOfKey(date).getDay()];
          return (
            <li key={date} className={`streak-day ${status}`}>
              <span className="streak-dot" aria-hidden="true" />
              <span className="streak-letter" aria-hidden="true">{day[0]}</span>
              <span className="visually-hidden">{`${day}: ${STATUS_TEXT[status]}`}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
