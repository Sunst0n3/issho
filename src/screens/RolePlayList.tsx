// Free role-plays: the scripts that fit what both partners have been taught (never a unit's
// core conversation, which Session A runs in stages), grouped by level.

import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MemberProgress } from '../../shared/api.ts';
import { splitHousehold, timeAgo } from '../components/together/household.ts';
import { LEVEL_NAMES, type Level } from '../components/together/rolePlay.ts';
import { rolePlayHistory } from '../components/together/storage.ts';
import '../components/together/together.css';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { loadCoreIndex, loadGrammarIndex, loadRolePlays, loadUnits } from '../lib/data.ts';
import { db } from '../lib/db.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { RolePlay, TargetRef } from '../lib/types.ts';
import { memberProgress } from '../srs/memberProgress.ts';
import { coupleSettledUnit, eligibleRolePlays } from '../srs/together.ts';
import { useHousehold } from '../sync/stats.ts';

const LEVELS: Level[] = [1, 2, 3];

/**
 * The free role-plays for this couple. A target counts as introduced for both when this phone
 * introduced it and the partner's progress reaches its order (this phone alone when unpaired).
 */
export async function freeRolePlays(partner: MemberProgress | null | undefined): Promise<RolePlay[]> {
  const [scripts, units, core, grammar, mine, items] = await Promise.all([
    loadRolePlays(),
    loadUnits().catch(() => []),
    loadCoreIndex().catch(() => new Map()),
    loadGrammarIndex().catch(() => new Map()),
    memberProgress().catch(() => undefined),
    db.items.where('kind').anyOf('core', 'grammar').primaryKeys(),
  ]);
  const introduced = new Set(items as string[]);
  const partnerHas = (t: TargetRef): boolean => {
    if (!partner) return true;
    const [kind, key] = t.split(':') as ['core' | 'grammar', string];
    const order = kind === 'core' ? core.get(key)?.order : grammar.get(key)?.order;
    if (order === undefined) return false;
    return order <= (kind === 'core' ? partner.coreReached : partner.grammarReached);
  };
  const coreConversations = new Set(units.map((u) => u.conversation));
  const settled = coupleSettledUnit(mine?.settledUnit ?? 0, partner?.settledUnit);
  return eligibleRolePlays(scripts, coreConversations, (t) => introduced.has(t) && partnerHas(t), settled);
}

export default function RolePlayList() {
  const rubyShow = useRubyShow();
  const { data } = useHousehold();
  const partner = splitHousehold(data).partner?.progress;
  const [scripts, setScripts] = useState<RolePlay[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [history] = useState(rolePlayHistory);
  const id = useId();
  const partnerKey = partner ? `${partner.coreReached}:${partner.grammarReached}:${partner.settledUnit}` : '';

  useEffect(() => {
    let live = true;
    setFailed(false);
    freeRolePlays(partner).then((s) => { if (live) setScripts(s); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt, partnerKey]);

  return (
    <Screen label="Role-plays">
      <TopBar back="/together" title="Role-plays" />
      <p className="muted">Short scenes to say out loud: together on two phones, or passing one back and forth. These fit the words and grammar you both know.</p>

      {failed && (
        <div className="tg-notice-card" role="alert">
          <h2>Role-plays didn't load</h2>
          <p>Something went wrong reading them on this phone.</p>
          <button type="button" className="btn secondary small" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      )}
      {!scripts && !failed && (
        <div aria-busy="true" aria-label="Loading role-plays">
          <div className="tg-skeleton-block" />
          <div className="tg-skeleton-block" />
        </div>
      )}
      {scripts?.length === 0 && (
        <p className="empty">No free role-play fits yet. They open up as you both learn the words they use.</p>
      )}

      {scripts && LEVELS.map((l) => {
        const atLevel = scripts.filter((s) => s.level === l);
        if (!atLevel.length) return null;
        return (
          <section key={l} className="tg-rp-level" aria-labelledby={`rp-level-${l}`}>
            <div className="tg-rp-level-head">
              <h2 id={`rp-level-${l}`} className="tg-rp-level-title">
                Level {l} <span className="muted">· {LEVEL_NAMES[l]}</span>
              </h2>
            </div>
            <ul className="tg-rp-list">
              {atLevel.map((s) => (
                <li key={s.id}>
                  {/* Named from its parts, so they are read with pauses between them. */}
                  <Link className="tg-rp-row" to={`/roleplay/${s.id}`}
                    aria-labelledby={['title', 'jp', 'setting', 'meta'].map((part) => `${id}-${s.id}-${part}`).join(' ')}>
                    <span className="tg-rp-row-body">
                      <span className="tg-rp-row-title" id={`${id}-${s.id}-title`}>{s.title}</span>
                      <span id={`${id}-${s.id}-jp`}><Ruby text={s.titleJp} show={rubyShow} className="tg-rp-row-jp" /></span>
                      <span className="tg-rp-row-setting" id={`${id}-${s.id}-setting`}>{s.setting}</span>
                      <span className="tg-rp-row-meta" id={`${id}-${s.id}-meta`}>
                        {s.lines.length} lines
                        {history[s.id] && <> · <Icon name="check" size={14} /> Done {timeAgo(history[s.id])}</>}
                      </span>
                    </span>
                    <Icon name="forward" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Screen>
  );
}
