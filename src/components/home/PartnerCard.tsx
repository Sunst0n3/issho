// Today screen: how the partner is doing today (from the home server, cached
// for offline), and the sync status footer.
import { Link } from 'react-router-dom';
import type { DayStats, MemberStats } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import { wasRemoved } from '../../sync/client.ts';
import { useServerStatus } from '../../sync/socket.ts';
import { useHousehold } from '../../sync/stats.ts';
import { splitHousehold } from '../together/household.ts';
import { Icon } from '../ui.tsx';
import { agoText, plural, streakText } from './labels.ts';
import { worksOffline } from './SecureNotice.tsx';

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
      detail: partner.streak > 0 ? `${streakText(partner.streak)} so far` : 'Say hi in Japanese',
    };
  }
  const parts = [`${day.newItems} new`, plural(day.reviews, 'review')];
  if (day.reviews > 0) parts.push(`${Math.round((day.correct / day.reviews) * 100)}% correct`);
  return {
    title: day.sessionComplete ? `${name} finished today` : `${name} is studying today`,
    detail: parts.join(' · '),
  };
}

/**
 * The link's name from its separate lines. Read from content, the stacked spans
 * would run together ("Ken finished today5 new").
 */
const linkName = (...lines: Array<string | false | undefined>) => lines.filter(Boolean).join('. ');

/** For a paired phone: the partner's day. Works offline from the last household copy. */
export function PartnerCard() {
  const { data, fetchedAt, loading, error } = useHousehold();

  if (!data) {
    const detail = loading || !error ? 'Checking in with your home server…' : "Can't reach your home server right now";
    return (
      <Link to="/together" className="today-partner quiet" aria-label={linkName('Together', detail)}>
        <span className="today-partner-text">
          <span className="today-partner-title">Together</span>
          <span className="today-partner-detail">{detail}</span>
        </span>
        <Icon name="forward" size={20} />
      </Link>
    );
  }

  // The other member seen most recently, as on the Together tab: a leftover (ghost) member
  // from before re-pairing reused members would otherwise hide the real partner.
  const { partner } = splitHousehold(data);
  if (!partner) {
    return (
      <Link to="/together" className="today-partner"
        aria-label={linkName('Waiting for your partner', 'They join with the same household code')}>
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
  const staleText = stale && fetchedAt !== undefined ? `Last update ${agoText(fetchedAt)}` : undefined;
  return (
    <Link to="/together" className="today-partner" aria-label={linkName(title, detail, staleText)}>
      <span className="today-partner-avatar" aria-hidden="true">{(partner.member.name || '?').slice(0, 1).toUpperCase()}</span>
      <span className="today-partner-text">
        <span className="today-partner-title">{title}</span>
        <span className="today-partner-detail">{detail}</span>
        {staleText && <span className="today-partner-stale">{staleText}</span>}
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
      {/* Without a secure address the app can't run offline, so it doesn't claim to. */}
      <span>{worksOffline() ? 'Works offline · progress saved on this phone' : 'Progress saved on this phone'}</span>
      {sync && <span className={`today-sync ${status}`} role="status">{sync}</span>}
    </footer>
  );
}
