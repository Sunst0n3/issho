// Today's together session on the Today screen: shown when a session is scheduled today or is
// still open from earlier this week. No props: it reads the together state and the household.

import { Link } from 'react-router-dom';
import { dayKey } from '../../lib/db.ts';
import { useSettings } from '../../lib/hooks.ts';
import { Icon } from '../ui.tsx';
import { SESSION_TITLES } from './session.ts';
import { sessionToOffer, useWeekPlan } from './weekPlan.ts';
import './together.css';

const MONTHLY_PARTS = 'quiz, goals, skit';

export function TogetherTodayCard() {
  const settings = useSettings();
  const { plan } = useWeekPlan();
  const today = dayKey();
  const offer = sessionToOffer(plan, today);
  if (!offer || !settings.onboarded) return null;

  const monthly = offer.id === 'monthly';
  const when = offer.status === 'overdue'
    ? 'still open this week'
    : monthly ? 'this weekend' : Number(offer.time.slice(0, 2)) >= 17 ? 'tonight' : 'today';
  const title = monthly ? `Monthly session ${when}` : `Session ${offer.id} ${when}`;
  const detail = monthly ? MONTHLY_PARTS : SESSION_TITLES[offer.id];

  return (
    <Link to={`/together/session/${offer.id}`} className="card tg-today-card">
      <span className="tg-today-icon" aria-hidden="true"><Icon name="people" size={22} /></span>
      <span className="tg-today-body">
        <span className="tg-today-title">{title}</span>
        <span className="tg-today-detail">{offer.status === 'overdue' ? detail : `${offer.time} · ${detail}`}</span>
      </span>
      <Icon name="forward" />
    </Link>
  );
}
