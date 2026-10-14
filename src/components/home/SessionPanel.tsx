// The dark "Today's session" panel on the Today screen: ready to study, done
// for today, review limit reached, all caught up, and course finished.
import { Link } from 'react-router-dom';
import type { NewItemPlan } from '../../srs/course.ts';
import type { SessionPlan } from '../../srs/planner.ts';
import { Icon } from '../ui.tsx';
import { plural } from './labels.ts';

function newLabel(items: readonly NewItemPlan[]): string {
  if (items.length && items.every((i) => i.kind === 'kanji')) return 'new kanji';
  if (items.length && items.every((i) => i.kind === 'kana')) return 'new kana';
  return items.length === 1 ? 'new item' : 'new items';
}

function ExtraPractice() {
  return (
    <div className="plan-actions">
      <Link to="/write" className="btn small on-plan"><Icon name="pen" size={18} />Practice writing</Link>
      <Link to="/read" className="btn small on-plan"><Icon name="book" size={18} />Read &amp; shadow</Link>
    </div>
  );
}

export function SessionPanel({ plan, todayDone, courseFinished }: {
  plan: SessionPlan;
  todayDone: boolean;
  courseFinished: boolean;
}) {
  const blocked = plan.newBlocked;

  if (todayDone) {
    return (
      <section className="plan-panel" aria-labelledby="session-title">
        <p className="plan-eyebrow" lang="ja">おつかれさま</p>
        <h2 id="session-title" className="plan-title">Done for today</h2>
        <p className="plan-copy">
          {plan.reviews.length > 0
            ? "Nice work: today's session is done. Extra reviews are up to you."
            : 'Nice work. Your next reviews will be waiting tomorrow.'}
        </p>
        {plan.reviews.length > 0 && (
          <Link to="/session" className="plan-more">
            {plural(plan.reviews.length, 'more review')} ready if you want to keep going
            <Icon name="forward" size={16} />
          </Link>
        )}
        <ExtraPractice />
      </section>
    );
  }

  if (!plan.reviews.length && !plan.newItems.length && !plan.reading.length) {
    return (
      <section className="plan-panel" aria-labelledby="session-title">
        {courseFinished ? (
          <>
            <h2 id="session-title" className="plan-title">You've met every kanji</h2>
            <p className="plan-copy">
              {plan.backlog > 0
                ? `You've reached today's review limit. ${plural(plan.backlog, 'more review')} will wait for tomorrow.`
                : "Reviews keep coming as they fall due, and there's always more to read."}
            </p>
          </>
        ) : plan.backlog > 0 ? (
          // Due cards are left, but only past today's review limit.
          <>
            <h2 id="session-title" className="plan-title">Today's reviews are done</h2>
            <p className="plan-copy">
              You've reached today's review limit. {plural(plan.backlog, 'more review')} will wait for tomorrow.
            </p>
          </>
        ) : (
          <>
            <h2 id="session-title" className="plan-title">All caught up</h2>
            <p className="plan-copy">Nothing is due right now. New items come back tomorrow.</p>
          </>
        )}
        {blocked && <p className="plan-note">{blocked.reason}</p>}
        <ExtraPractice />
      </section>
    );
  }

  const later = plan.backlog - plan.reviews.length;
  return (
    <section className="plan-panel" aria-labelledby="session-title">
      <div className="plan-head">
        <h2 id="session-title" className="plan-title small">Today's session</h2>
        <span className="plan-time">about {plan.estimateMinutes} min</span>
      </div>
      <ul className="plan-tiles">
        <li>
          <strong>{plan.reviews.length}</strong>
          <span>{plan.reviews.length === 1 ? 'review due' : 'reviews due'}</span>
        </li>
        <li className={blocked ? 'paused' : undefined}>
          <strong>{blocked ? '–' : plan.newItems.length}</strong>
          <span>{blocked ? 'new paused' : newLabel(plan.newItems)}</span>
        </li>
        <li>
          <strong>{plan.reading.length}</strong>
          <span>{plan.reading.length === 1 ? 'sentence' : 'sentences'}</span>
        </li>
      </ul>
      {blocked && <p className="plan-note">{blocked.reason}</p>}
      {later > 0 && <p className="plan-note">{plural(later, 'more review')} will wait for tomorrow.</p>}
      <Link to="/session" className="btn primary block">
        Start session <Icon name="arrow" size={20} />
      </Link>
    </section>
  );
}
