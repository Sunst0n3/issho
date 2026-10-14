// Every role-play, grouped by level, with the level that fits your phase marked.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { timeAgo } from '../components/together/household.ts';
import { LEVEL_NAMES, levelForPhase, type Level } from '../components/together/rolePlay.ts';
import { rolePlayHistory } from '../components/together/storage.ts';
import '../components/together/together.css';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { loadRolePlays } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { RolePlay } from '../lib/types.ts';
import { currentPhase } from '../srs/course.ts';

const LEVELS: Level[] = [1, 2, 3];

export default function RolePlayList() {
  const rubyShow = useRubyShow();
  const [scripts, setScripts] = useState<RolePlay[]>();
  const [failed, setFailed] = useState(false);
  const [level, setLevel] = useState<Level>();
  const [attempt, setAttempt] = useState(0);
  const [history] = useState(rolePlayHistory);

  useEffect(() => {
    let live = true;
    setFailed(false);
    loadRolePlays().then((s) => { if (live) setScripts(s); }, () => { if (live) setFailed(true); });
    currentPhase().then((p) => { if (live) setLevel(levelForPhase(p)); }, () => { /* no highlight */ });
    return () => { live = false; };
  }, [attempt]);

  return (
    <Screen label="Role-plays">
      <TopBar back="/together" title="Role-plays" />
      <p className="muted">Short scenes to say out loud: together on two phones, or passing one back and forth.</p>

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
      {scripts?.length === 0 && <p className="empty">No role-plays yet. They arrive with the next update.</p>}

      {scripts && LEVELS.map((l) => {
        const atLevel = scripts.filter((s) => s.level === l);
        if (!atLevel.length) return null;
        const recommended = l === level;
        return (
          <section key={l} className={recommended ? 'tg-rp-level tg-recommended' : 'tg-rp-level'} aria-labelledby={`rp-level-${l}`}>
            <h2 id={`rp-level-${l}`} className="tg-rp-level-title">
              Level {l} <span className="muted">· {LEVEL_NAMES[l]}</span>
              {recommended && <span className="chip shu">For you now</span>}
            </h2>
            <ul className="tg-rp-list">
              {atLevel.map((s) => (
                <li key={s.id}>
                  <Link className="tg-rp-row" to={`/roleplay/${s.id}`}>
                    <span className="tg-rp-row-body">
                      <span className="tg-rp-row-title">{s.title}</span>
                      <Ruby text={s.titleJp} show={rubyShow} className="tg-rp-row-jp" />
                      <span className="tg-rp-row-setting">{s.setting}</span>
                      <span className="tg-rp-row-meta">
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
