// The dark "today's plan" panel on Today: minutes today and tomorrow, what the session holds,
// and the ways in (full session, 3-minute session, one more kanji). No card counts in catch-up.
import { Link } from 'react-router-dom';
import type { NewItemPlan } from '../../srs/course.ts';
import type { DayPlan } from '../../srs/planner.ts';
import { Icon } from '../ui.tsx';

/**
 * "About 25 min today · tomorrow about 24", or "About 12 min left today · …" after an earlier sitting. Tomorrow's
 * minutes are the governor's plan for tomorrow: 0 on a travel day with nothing due, which reads "nothing planned".
 */
export function minutesLine(plan: Pick<DayPlan, 'estimateMin' | 'partOfDayDone' | 'tomorrowMin'>): string {
  const today = plan.partOfDayDone ? `About ${plan.estimateMin} min left today` : `About ${plan.estimateMin} min today`;
  return `${today} · ${plan.tomorrowMin > 0 ? `tomorrow about ${plan.tomorrowMin}` : 'nothing planned tomorrow'}`;
}

/** "Tomorrow about 24 min." or "Nothing planned tomorrow." */
export function tomorrowSentence(tomorrowMin: number): string {
  return tomorrowMin > 0 ? `Tomorrow about ${tomorrowMin} min.` : 'Nothing planned tomorrow.';
}

export function plannedItems(plan: Pick<DayPlan, 'teach'>): NewItemPlan[] {
  return plan.teach.flatMap((batch) => batch.items);
}

/** The count includes what comes along (a kanji's anchor word), so only an all-kana day gets its own word. */
function newLabel(items: readonly NewItemPlan[], count: number): string {
  if (items.length && items.every((i) => i.kind === 'kana')) return 'new kana';
  return count === 1 ? 'new item' : 'new items';
}

function hasWork(plan: DayPlan): boolean {
  return plan.estimateMin > 0
    || plan.warmup.length > 0
    || plan.teach.length > 0
    || plan.pendingCheck.length > 0
    || plan.read !== null
    || plan.output !== null
    || plan.fluency !== null;
}

function ExtraPractice() {
  return (
    <div className="plan-actions">
      <Link to="/library" className="btn small on-plan"><Icon name="library" size={18} />Library</Link>
      <Link to="/read" className="btn small on-plan"><Icon name="book" size={18} />Read</Link>
    </div>
  );
}

function MicroLink() {
  return (
    <Link to="/session?mode=micro" className="plan-more">
      Short on time? 3-minute session <Icon name="forward" size={16} />
    </Link>
  );
}

export function PlanPanel({ plan, goalMet }: {
  plan: DayPlan;
  /** Today's full plan is done (StreakV2.todayGoal). */
  goalMet: boolean;
}) {
  if (goalMet) {
    const more = plan.warmup.length > 0 || plan.teach.length > 0;
    return (
      <section className="plan-panel" aria-labelledby="plan-title">
        <p className="plan-eyebrow" lang="ja">おつかれさま</p>
        <h2 id="plan-title" className="plan-title">Done for today</h2>
        <p className="plan-copy">Today's goal is met. {tomorrowSentence(plan.tomorrowMin)}</p>
        {more && (
          <Link to="/session" className="plan-more">
            Keep going if you like <Icon name="forward" size={16} />
          </Link>
        )}
        <ExtraPractice />
      </section>
    );
  }

  if (plan.mode === 'travel') {
    return (
      <section className="plan-panel" aria-labelledby="plan-title">
        <h2 id="plan-title" className="plan-title small">Travel mode</h2>
        <p className="plan-copy">
          Nothing new while you're away, and reviews are optional. Your streak waits for you.
        </p>
        {plan.warmup.length > 0 && (
          <Link to="/session" className="btn primary block">
            Review anyway <Icon name="arrow" size={20} />
          </Link>
        )}
      </section>
    );
  }

  if (!hasWork(plan)) {
    return (
      <section className="plan-panel" aria-labelledby="plan-title">
        <h2 id="plan-title" className="plan-title">{plan.courseComplete ? "You've met every kanji" : 'All caught up'}</h2>
        <p className="plan-copy">
          {plan.courseComplete
            ? "Reviews keep coming as they fall due, and there's always more to read."
            : `Nothing is due right now. ${tomorrowSentence(plan.tomorrowMin)}`}
        </p>
        <ExtraPractice />
      </section>
    );
  }

  const items = plannedItems(plan);
  const catchUp = plan.mode === 'catch-up' || plan.counts === undefined;
  return (
    <section className="plan-panel" aria-labelledby="plan-title">
      <div className="plan-head">
        <h2 id="plan-title" className="plan-title small">Today's plan</h2>
        <span className="plan-time">{minutesLine(plan)}</span>
      </div>
      {catchUp ? (
        <p className="plan-copy">
          Reviews first today, the ones closest to slipping. New items come back once they settle.
        </p>
      ) : (
        <ul className="plan-tiles">
          <li>
            <strong>{plan.counts!.reviews}</strong>
            <span>{plan.counts!.reviews === 1 ? 'review' : 'reviews'}</span>
          </li>
          <li>
            <strong>{plan.counts!.newItems}</strong>
            <span>{newLabel(items, plan.counts!.newItems)}</span>
          </li>
          <li>
            <strong>{plan.read ? plan.read.minutes : '–'}</strong>
            <span>{plan.read ? 'min read & listen' : 'read & listen'}</span>
          </li>
        </ul>
      )}
      {plan.brake && !catchUp && <p className="plan-note">New items are lighter today while reviews settle.</p>}
      {plan.offerExtraKanji && (
        <Link to="/session?extra=1" className="plan-more">
          Add one more kanji today? <Icon name="plus" size={16} />
        </Link>
      )}
      <Link to="/session" className="btn primary block">
        Start session <Icon name="arrow" size={20} />
      </Link>
      <MicroLink />
    </section>
  );
}
