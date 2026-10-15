import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { CardFamily } from '../../lib/types.ts';
import type { StreakV2 } from '../../srs/habits.ts';
import type { RetentionStat } from '../../srs/progress.ts';
import { Icon } from '../ui.tsx';

export interface SummaryData {
  /** "You can now …" from today's items; absent when nothing new was introduced. */
  canNow?: string;
  /** Today's study minutes, every sitting together. */
  minutesToday: number;
  /** "Tomorrow about N min"; 0 (a travel day with nothing due) reads "Nothing planned". */
  tomorrowMin?: number;
  /** Shown on the first sitting of each ISO week. */
  retention?: RetentionStat[];
  streak?: StreakV2;
}

const FAMILY_NAMES: Record<CardFamily, string> = {
  write: 'Writing',
  read: 'Reading',
  listen: 'Listening',
  produce: 'Saying',
  grammar: 'Grammar',
};

const pct = (rate: number) => `${Math.round(rate * 100)} %`;

/** Real recall by card family at about 1 week and about 1 month (hidden while there are fewer than 10 answers). */
export function RetentionCard({ stats }: { stats: readonly RetentionStat[] }) {
  const rows = stats.filter((s) => s.week.rate !== null || s.month.rate !== null);
  if (!rows.length) return null;
  return (
    <section className="card st-retention" aria-labelledby="st-retention-title">
      <h2 id="st-retention-title" className="label">Real recall this month</h2>
      <ul>
        {rows.map((s) => (
          <li key={s.family}>
            <span className="st-retention-family">{FAMILY_NAMES[s.family]}</span>
            <span>
              {s.week.rate !== null && <>about 1 week <strong>{pct(s.week.rate)}</strong></>}
              {s.week.rate !== null && s.month.rate !== null && ', '}
              {s.month.rate !== null && <>about 1 month <strong>{pct(s.month.rate)}</strong></>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const WEEKDAY = new Intl.DateTimeFormat('en', { weekday: 'long' });
/** 'Tuesday' for a day key. */
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAY.format(new Date(y, m - 1, d, 12));
}

export function SessionSummary({ data, onDone, onMakeup }: {
  data?: SummaryData;
  onDone: () => void;
  /** The make-up offer was taken: the session leaves for it (in place of following the link). */
  onMakeup?: () => void;
}) {
  // The last answer's button is gone: start screen readers and keyboards at the title.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);
  const repairable = data?.streak?.makeupOffer ? data.streak.repairable : undefined;
  return (
    <section className="st-summary" aria-labelledby="st-summary-title">
      <p className="st-eyebrow" lang="ja">おつかれさま</p>
      <h1 id="st-summary-title" className="st-summary-title" ref={title} tabIndex={-1}>Done for now</h1>

      {!data ? (
        <div className="st-skeleton st-skeleton-list" aria-busy="true" aria-label="Adding up today" />
      ) : (
        <>
          {data.canNow && <p className="card st-can-now">{data.canNow}</p>}
          <dl className="st-stats two">
            <div><dt>Today</dt><dd>{data.minutesToday} min</dd></div>
            {data.tomorrowMin !== undefined && (
              <div><dt>Tomorrow</dt><dd>{data.tomorrowMin > 0 ? `about ${data.tomorrowMin} min` : 'Nothing planned'}</dd></div>
            )}
          </dl>
          {data.streak?.alive && data.streak.current > 1 && (
            <div className="card st-streak">
              <span className="st-streak-badge"><Icon name="flame" size={22} filled /></span>
              <span><strong>{data.streak.current} days in a row</strong></span>
            </div>
          )}
          {data.retention && <RetentionCard stats={data.retention} />}
          {repairable && (
            <Link className="card st-link" to="/session?mode=makeup"
              onClick={onMakeup && ((e) => {
                e.preventDefault();
                onMakeup();
              })}>
              <Icon name="refresh" size={22} />
              <span><strong>Make up {weekdayOf(repairable.date)}: 10 more minutes</strong><span className="muted">Keeps your streak</span></span>
              <Icon name="forward" size={18} />
            </Link>
          )}
        </>
      )}

      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onDone}>Done</button>
      </div>
    </section>
  );
}

/**
 * Why a sitting has nothing to do: 'done' (nothing due and today's new items are done), 'desk' (a phone-only sitting
 * with no reviews due while today's lessons, reading or first check still wait for a desk sitting), 'short' (a short
 * session from Today with nothing due; it never holds new items).
 */
export type EmptyReason = 'done' | 'desk' | 'short';

const EMPTY_TEXT: Record<EmptyReason, { title: string; text: string }> = {
  done: {
    title: "You're all caught up",
    text: "Nothing is due right now and today's new items are done. Cards come back as they are due. Until then:",
  },
  desk: {
    title: 'No reviews right now',
    text: "Nothing is due for a phone-only sitting. Today's lessons, reading and first check need a pen: choose \"At my desk\" or \"All of it\" when you can.",
  },
  short: {
    title: "You're all caught up",
    text: 'Nothing is due right now. Cards come back as they are due. Until then:',
  },
};

/** Nothing left to do in this sitting: say why, and point to what is open (another sitting, reading, grammar). */
export function SessionEmpty({ reason = 'done', onChooseSitting }: {
  reason?: EmptyReason;
  /** 'desk': back to the sitting choice. */
  onChooseSitting?: () => void;
}) {
  const copy = EMPTY_TEXT[reason];
  return (
    <section className="st-summary st-empty" aria-labelledby="st-empty-title">
      <p className="st-eyebrow" lang="ja">よくできました</p>
      <h1 id="st-empty-title" className="st-summary-title">{copy.title}</h1>
      <p className="muted">{copy.text}</p>
      {reason === 'desk' && onChooseSitting && (
        <button type="button" className="btn primary block" onClick={onChooseSitting}>Choose another sitting</button>
      )}
      <div className="st-links">
        <Link className="card st-link" to="/read">
          <Icon name="book" size={22} />
          <span><strong>Read</strong><span className="muted">Stories and sentences at your level</span></span>
          <Icon name="forward" size={18} />
        </Link>
        <Link className="card st-link" to="/grammar">
          <Icon name="pen" size={22} />
          <span><strong>Grammar</strong><span className="muted">Look back at what you have learned</span></span>
          <Icon name="forward" size={18} />
        </Link>
      </div>
      <div className="st-footer">
        <Link className="btn ink st-grow" to="/">Back to today</Link>
      </div>
    </section>
  );
}
