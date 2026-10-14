// Today screen: how the partner is doing today (from the home server, cached
// for offline), and the sync status footer.
import { Link } from 'react-router-dom';
import type { DayStats, MemberStats } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import { wasRemoved } from '../../sync/client.ts';
import { useServerStatus } from '../../sync/socket.ts';
import { useHousehold } from '../../sync/stats.ts';
import { Icon } from '../ui.tsx';
import { agoText, plural } from './labels.ts';

const STALE_MS = 10 * 60_000;

function studied(day: DayStats | undefined): day is DayStats {
  return Boolean(day && (day.sessionComplete || day.reviews > 0 || day.newItems > 0 || day.studyMinutes > 0));
}

function partnerLines(partner: MemberStats, today: string): { title: string; detail: string } {
  const name = partner.member.name || 'Your partner';
  // Household days carry their own dates; only a day dated today counts as today.
  const day = partner.days.find((d) => d.date === today);
  if (!studied(day)) {
    return {
      title: `${name} hasn't studied yet today`,
      detail: partner.streak > 0 ? `${plural(partner.streak, 'day')} streak so far` : 'Say hi in Japanese',
    };
  }
  const parts = [`${day.newItems} new`, plural(day.reviews, 'review')];
  if (day.reviews > 0) parts.push(`${Math.round((day.correct / day.reviews) * 100)}% correct`);
  return {
    title: day.sessionComplete ? `${name} finished today` : `${name} is studying today`,
    detail: parts.join(' · '),
  };
}

/** For a paired phone: the partner's day. Works offline from the last household copy. */
export function PartnerCard() {
  const { data, fetchedAt, loading, error } = useHousehold();

  if (!data) {
    return (
      <Link to="/together" className="today-partner quiet">
        <span className="today-partner-text">
          <span className="today-partner-title">Together</span>
          <span className="today-partner-detail">
            {loading || !error ? 'Checking in with your home server…' : "Can't reach your home server right now"}
          </span>
        </span>
        <Icon name="forward" size={20} />
      </Link>
    );
  }

  const partner = data.members.find((m) => m.member.id !== data.me);
  if (!partner) {
    return (
      <Link to="/together" className="today-partner">
        <span className="today-partner-avatar" aria-hidden="true"><Icon name="people" size={20} /></span>
        <span className="today-partner-text">
          <span className="today-partner-title">Waiting for your partner</span>
          <span className="today-partner-detail">They join with the same household code</span>
        </span>
        <Icon name="forward" size={20} />
      </Link>
    );
  }

  const { title, detail } = partnerLines(partner, dayKey());
  const stale = fetchedAt !== undefined && Date.now() - fetchedAt > STALE_MS;
  return (
    <Link to="/together" className="today-partner">
      <span className="today-partner-avatar" aria-hidden="true">{(partner.member.name || '?').slice(0, 1).toUpperCase()}</span>
      <span className="today-partner-text">
        <span className="today-partner-title">{title}</span>
        <span className="today-partner-detail">{detail}</span>
        {stale && fetchedAt !== undefined && <span className="today-partner-stale">Last update {agoText(fetchedAt)}</span>}
      </span>
      <Icon name="forward" size={20} />
    </Link>
  );
}

/** For a phone that isn't paired: a quiet pointer to the together features. */
export function ConnectHint() {
  return (
    <Link to="/together" className="today-connect">
      <Icon name="people" size={18} />
      <span>{wasRemoved() ? 'This phone was disconnected: connect again' : 'Study together: connect your home server'}</span>
      <Icon name="forward" size={16} />
    </Link>
  );
}

const SYNC_TEXT = { online: 'Synced', offline: 'Offline', connecting: 'Connecting…', unpaired: '' } as const;

export function SyncFooter({ paired }: { paired: boolean }) {
  const status = useServerStatus();
  const sync = paired ? SYNC_TEXT[status] : '';
  return (
    <footer className="today-footer">
      <Icon name="check" size={16} />
      <span>Works offline · progress saved on this phone</span>
      {sync && <span className={`today-sync ${status}`} role="status">{sync}</span>}
    </footer>
  );
}
