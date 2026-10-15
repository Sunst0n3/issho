// A role-play, spoken out loud. Two ways to do it: together on two phones (each
// phone shows its own part and both advance together over the socket), or on
// one phone (pick a part and pass it back and forth, or read both parts).

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { splitHousehold } from '../components/together/household.ts';
import { useFocusWhenLost } from '../components/together/focus.ts';
import { dismissInvite, useRolePlayInvite } from '../components/together/live.ts';
import {
  initialRun,
  isMyLine,
  LEVEL_NAMES,
  lineClip,
  other,
  runReducer,
  syncStateOf,
  type Part,
  type RunAction,
  type RunMode,
} from '../components/together/rolePlay.ts';
import { RolePlayLine } from '../components/together/RolePlayLine.tsx';
import type { Verdict } from '../components/together/SayIt.tsx';
import { recordRolePlayDone } from '../components/together/storage.ts';
import '../components/together/together.css';
import { Icon, ProgressBar, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { loadRolePlays } from '../lib/data.ts';
import { useRubyShow, useSettings } from '../lib/hooks.ts';
import type { RolePlay } from '../lib/types.ts';
import { addStudyTime } from '../srs/progress.ts';
import { uuid } from '../sync/outbox.ts';
import { onServerEvent, sendClientEvent, usePresence, useServerStatus } from '../sync/socket.ts';
import { useHousehold } from '../sync/stats.ts';

/** A waiting phone repeats its invite this often, so a partner who opens the script late still sees it. */
const INVITE_REPEAT_MS = 3_000;
/** Study time counted for one run is capped, in case the phone was left open. */
const MAX_RUN_MS = 30 * 60_000;

export default function RolePlayRun() {
  const { id } = useParams();
  const [scripts, setScripts] = useState<RolePlay[]>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadRolePlays().then((s) => { if (live) setScripts(s); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const script = scripts?.find((s) => s.id === id);
  if (failed || (scripts && !script)) {
    return (
      <Screen label="Role-play">
        <TopBar back="/roleplay" title="Role-play" />
        <div className="tg-notice-card" role="alert">
          <h2>{failed ? "This role-play didn't load" : "We couldn't find that role-play"}</h2>
          <p>Pick one from the list instead.</p>
          <Link className="btn secondary small" to="/roleplay">All role-plays</Link>
        </div>
      </Screen>
    );
  }
  if (!script) {
    return (
      <Screen label="Role-play">
        <TopBar back="/roleplay" title="Role-play" />
        <div className="tg-skeleton-block tg-tall" aria-busy="true" aria-label="Loading role-play" />
      </Screen>
    );
  }
  return <Run key={script.id} script={script} />;
}

function Run({ script }: { script: RolePlay }) {
  const settings = useSettings();
  const status = useServerStatus();
  const rubyShow = useRubyShow();
  const { data } = useHousehold();
  const { partner } = splitHousehold(data);
  const partnerName = partner?.member.name ?? 'Your partner';
  const presence = usePresence(partner?.member.id);
  const invite = useRolePlayInvite(script.id);
  const [run, dispatch] = useReducer(runReducer, undefined, initialRun);
  const total = script.lines.length;
  const roleName = (p: Part) => (p === 'both' ? 'both parts' : script.roles[p].name);

  // ---- Two-phone sync -------------------------------------------------------
  const sync = syncStateOf(run, script.id);
  const syncKey = sync ? JSON.stringify(sync) : '';
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!sync) return;
    sendClientEvent({ type: 'roleplay', state: sync });
    if (sync.status !== 'waiting') return;
    const t = setInterval(() => sendClientEvent({ type: 'roleplay', state: sync }), INVITE_REPEAT_MS);
    return () => clearInterval(t);
    // syncKey stands for `sync`; a reconnect (status) sends it again.
  }, [syncKey, status]);

  useEffect(() => onServerEvent((ev) => {
    if (ev.type !== 'roleplay' || ev.state.scriptId !== script.id) return;
    const current = runRef.current;
    if (ev.state.sessionId !== current.sessionId) return;
    const action: RunAction = { type: 'remote', state: ev.state, total };
    dispatch(action);
    // Their phone is behind ours: still waiting because our join was lost, or back from a
    // dropped connection on an earlier line. Say where we are so it catches up; our own
    // state is only sent when it changes.
    const after = runReducer(current, action);
    const behind = ev.state.status === 'waiting'
      || (ev.state.status === 'active' && ev.state.lineIndex < after.lineIndex);
    const mine = syncStateOf(after, script.id);
    if (behind && mine && after.step !== 'waiting') sendClientEvent({ type: 'roleplay', state: mine });
  }), [script.id, total]);

  // Leaving the wait (cancel, solo, or this screen) withdraws the invite at once, so the
  // partner's phone can't join a session nobody is in while it waits to expire.
  const withdrawInvite = useCallback(() => {
    const waiting = syncStateOf(runRef.current, script.id);
    if (waiting?.status === 'waiting') sendClientEvent({ type: 'roleplay', state: { ...waiting, status: 'done' } });
  }, [script.id]);
  useEffect(() => withdrawInvite, [withdrawInvite]);

  // Both phones started waiting on the same script: the later session joins the earlier one.
  useEffect(() => {
    if (run.step === 'waiting' && invite && invite.state.sessionId < run.sessionId) {
      dispatch({ type: 'join', state: invite.state });
    }
  }, [run.step, run.sessionId, invite]);

  // ---- Progress -----------------------------------------------------------------
  const startedAt = useRef(0);
  const verdicts = useRef(new Map<number, Verdict>());
  /** Lines this phone got to in this round. The partner's phone can finish early, skipping the rest. */
  const reached = useRef(new Set<number>());
  const [lineVerdict, setLineVerdict] = useState<{ key: string; verdict: Verdict }>();
  const lineKey = `${run.round}:${run.lineIndex}`;
  const verdict = lineVerdict?.key === lineKey ? lineVerdict.verdict : undefined;

  useLayoutEffect(() => {
    verdicts.current = new Map();
    reached.current = new Set();
  }, [run.round]);
  useLayoutEffect(() => {
    if (run.step === 'active') reached.current.add(run.lineIndex);
  }, [run.step, run.lineIndex, run.round]);
  useEffect(() => {
    if (run.step === 'active' && !startedAt.current) startedAt.current = Date.now();
  }, [run.step, run.round]);

  useEffect(() => {
    if (run.step !== 'done') return;
    recordRolePlayDone(script.id);
    // Speaking practice counts as strand time (it shares the day's budget with reading and output).
    if (startedAt.current) void addStudyTime(Math.min(MAX_RUN_MS, Date.now() - startedAt.current), 'strand').catch(() => {});
    startedAt.current = 0;
  }, [run.step, run.round, script.id]);

  const onVerdict = (v: Verdict) => {
    verdicts.current.set(run.lineIndex, v);
    setLineVerdict({ key: lineKey, verdict: v });
  };

  // ---- Focus: each step replaces the button that was pressed -------------------------
  const lineRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusWhenLost(lineRef, `${run.step}:${lineKey}`);
  useFocusWhenLost(headingRef, `${run.step}:${run.round}`);

  // ---- Screens --------------------------------------------------------------------
  if (run.step === 'setup') {
    return (
      <Setup script={script} rubyShow={rubyShow} mode={run.mode} part={run.part} dispatch={dispatch}
        paired={Boolean(settings.deviceToken)} online={status === 'online'} partnerName={partnerName}
        hasPartner={Boolean(partner)} presence={presence}
        invite={invite ? { role: invite.state.role, onJoin: () => {
          dismissInvite(invite.state.sessionId);
          dispatch({ type: 'join', state: invite.state });
        } } : undefined}
        roleName={roleName} />
    );
  }

  if (run.step === 'waiting') {
    return (
      <Screen label={script.title}>
        <TopBar back="/roleplay" title={script.title} heading={false} />
        <div className="tg-rp-waiting card" role="status">
          <span className="tg-pulse tg-big" aria-hidden="true" />
          <h1 ref={headingRef}>Waiting for {partnerName}…</h1>
          <p>On {partnerName}'s phone: open Together, then this role-play. It will offer to join you.</p>
          <p className="muted">You're {roleName(run.part)}.</p>
          {status !== 'online' && <p className="tg-say-note">You're offline right now. We'll keep trying.</p>}
        </div>
        <button type="button" className="btn secondary block" onClick={() => { withdrawInvite(); dispatch({ type: 'solo' }); }}>
          Do it on this phone instead
        </button>
        <button type="button" className="btn ghost block" onClick={() => { withdrawInvite(); dispatch({ type: 'cancel' }); }}>
          Cancel
        </button>
      </Screen>
    );
  }

  if (run.step === 'done') {
    // Only lines this phone got to: when the partner's phone ends the run early, the rest weren't said.
    const myLines = script.lines.filter((l, i) => isMyLine(run.part, l.role) && reached.current.has(i)).length;
    const checked = [...verdicts.current.values()];
    const great = checked.filter((v) => v === 'great').length;
    return (
      <Screen label={script.title}>
        <TopBar close="/roleplay" title={script.title} heading={false} />
        <div className="tg-rp-done">
          <p className="tg-eyebrow" lang="ja">おつかれさま</p>
          <h1 ref={headingRef} className="tg-together-title">Nicely done</h1>
          <p>You finished “{script.title}”{run.part === 'both' ? ', reading both parts.' : ` as ${roleName(run.part)}.`}</p>
          <dl className="tg-stat-row">
            <div className="tg-stat"><dt>Lines you said</dt><dd>{myLines}</dd></div>
            {checked.length > 0 && <div className="tg-stat"><dt>Spot on</dt><dd>{great}</dd></div>}
            <div className="tg-stat"><dt>Lines in all</dt><dd>{total}</dd></div>
          </dl>
        </div>
        <button type="button" className="btn primary block" onClick={() => dispatch({ type: 'again', swap: true })}>
          {run.part === 'both' ? 'Go again' : 'Swap roles and go again'}
        </button>
        <Link className="btn secondary block" to="/roleplay">Pick another role-play</Link>
        <Link className="btn ghost block" to="/together">Back to Together</Link>
      </Screen>
    );
  }

  const line = script.lines[run.lineIndex];
  const prev = run.lineIndex > 0 ? script.lines[run.lineIndex - 1] : undefined;
  const mine = isMyLine(run.part, line.role);
  const duo = run.mode === 'duo';
  const last = run.lineIndex === total - 1;
  const next = () => dispatch({ type: 'next', total });

  return (
    <Screen label={script.title}>
      <TopBar close="/roleplay" heading={false}
        title={<ProgressBar value={run.lineIndex / total} label="Role-play progress" />}
        right={(
          <span className="tg-rp-count" aria-live="polite">
            <span aria-hidden="true">{run.lineIndex + 1} / {total}</span>
            <span className="visually-hidden">Line {run.lineIndex + 1} of {total}</span>
          </span>
        )} />
      <h1 className="visually-hidden">{script.title}</h1>

      {duo && (
        <p className={status === 'online' ? 'tg-rp-duo' : 'tg-rp-duo tg-offline'}>
          {status === 'online'
            ? <>With {partnerName} · you're {roleName(run.part)}</>
            : <><Icon name="cloudOff" size={16} /> Connection lost. Carry on with Next; you'll sync when it's back.</>}
        </p>
      )}

      {prev && (
        <p className="tg-rp-prev">
          <span className="tg-rp-who">{script.roles[prev.role].name}</span>
          <Ruby text={prev.jp} show={rubyShow} />
        </p>
      )}

      <RolePlayLine ref={lineRef} key={lineKey} line={line} roles={script.roles} mine={mine} readingBoth={run.part === 'both'}
        partnerLabel={duo ? partnerName : 'your partner'} clip={lineClip(script.id, run.lineIndex, line)} onVerdict={onVerdict} />

      <div className="tg-rp-bottom">
        {mine ? (
          <button type="button" className="btn primary block" onClick={next}>
            {verdict === 'great' || verdict === 'close' ? (last ? 'Finish' : 'Next') : 'I said it'}
          </button>
        ) : duo ? (
          <>
            <p className="tg-rp-wait-note" role="status">{partnerName} is saying this line…</p>
            <button type="button" className="btn secondary block" onClick={next}>{last ? 'Finish' : 'Next'}</button>
          </>
        ) : (
          <button type="button" className="btn primary block" onClick={next}>{last ? 'Finish' : 'Next'}</button>
        )}
      </div>
    </Screen>
  );
}

function Setup({ script, rubyShow, mode, part, dispatch, paired, online, hasPartner, partnerName, presence, invite, roleName }: {
  script: RolePlay;
  rubyShow: ReturnType<typeof useRubyShow>;
  mode: RunMode;
  part: Part;
  dispatch: (action: RunAction) => void;
  paired: boolean;
  online: boolean;
  hasPartner: boolean;
  partnerName: string;
  presence: boolean | undefined;
  invite?: { role: 'a' | 'b'; onJoin(): void };
  roleName(part: Part): string;
}) {
  const id = useId();
  const duoAvailable = paired && online && hasPartner && presence !== false;
  const duoNote = !paired ? 'Connect to your home server on the Together tab first.'
    : !online ? "You're offline right now."
      : !hasPartner ? "Your partner hasn't joined the household yet."
        : presence === false ? `${partnerName} is offline right now.`
          : presence ? `${partnerName} is online. Each phone shows its own part.`
            : `${partnerName} opens this role-play on their phone too.`;
  const chosenMode = duoAvailable ? mode : 'solo';
  const parts: Part[] = chosenMode === 'duo' ? ['a', 'b'] : ['a', 'b', 'both'];

  return (
    <Screen label={script.title}>
      <TopBar back="/roleplay" title="Role-play" heading={false} />
      <header className="tg-rp-head">
        <span className="chip ai">Level {script.level} · {LEVEL_NAMES[script.level]}</span>
        <h1 className="tg-together-title">{script.title}</h1>
        <p className="tg-rp-title-jp"><Ruby text={script.titleJp} show={rubyShow} /></p>
        <p className="muted">{script.setting}</p>
        <p className="tg-rp-cast">
          {(['a', 'b'] as const).map((r) => (
            <span key={r}><strong>{script.roles[r].name}</strong> <Ruby text={script.roles[r].nameJp} show={rubyShow} /></span>
          ))}
        </p>
      </header>

      {invite && (
        <div className="tg-invite-card" role="status">
          <p><strong>{partnerName} started this role-play</strong> as {roleName(invite.role)}.</p>
          <button type="button" className="btn indigo block" onClick={invite.onJoin}>
            Join as {roleName(other(invite.role))}
          </button>
        </div>
      )}

      <fieldset className="tg-option-group">
        <legend className="label">How do you want to practice?</legend>
        <label className={duoAvailable ? 'tg-option-card' : 'tg-option-card tg-disabled'}>
          <input type="radio" name="rp-mode" value="duo" checked={chosenMode === 'duo'} disabled={!duoAvailable}
            aria-labelledby={`${id}-duo`} aria-describedby={`${id}-duo-note`}
            onChange={() => dispatch({ type: 'mode', mode: 'duo' })} />
          <span className="tg-option-text">
            <strong id={`${id}-duo`}>Together, two phones</strong>
            <span id={`${id}-duo-note`} className="muted">{duoNote}</span>
          </span>
        </label>
        <label className="tg-option-card">
          <input type="radio" name="rp-mode" value="solo" checked={chosenMode === 'solo'}
            aria-labelledby={`${id}-solo`} aria-describedby={`${id}-solo-note`}
            onChange={() => dispatch({ type: 'mode', mode: 'solo' })} />
          <span className="tg-option-text">
            <strong id={`${id}-solo`}>On this phone</strong>
            <span id={`${id}-solo-note`} className="muted">Pass it back and forth, or read both parts yourself.</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="tg-option-group">
        <legend className="label">Your part</legend>
        <div className="segmented" role="radiogroup" aria-label="Your part">
          {parts.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={part === p}
              onClick={() => dispatch({ type: 'part', part: p })}>
              {p === 'both' ? 'Both' : script.roles[p].name}
            </button>
          ))}
        </div>
      </fieldset>

      <button type="button" className="btn primary block"
        onClick={() => {
          if (chosenMode !== mode) dispatch({ type: 'mode', mode: chosenMode });
          dispatch({ type: 'start', sessionId: uuid() });
        }}>
        {chosenMode === 'duo' ? 'Start together' : 'Start'}
      </button>
    </Screen>
  );
}
