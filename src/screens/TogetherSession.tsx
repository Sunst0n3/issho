// A together session (/together/session/:id, id = A, B, C or monthly). Two ways to run it:
// on two phones (duo: the phone that opens first leads, the other joins and follows its plan)
// or on one phone passed back and forth. At the end the session is credited once for the day,
// for both partners, whoever's phone reports it.

import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MemberProgress, TogetherLiveState, TogetherSessionId, TogetherSlot } from '../../shared/api.ts';
import { useAiAvailable } from '../components/together/ai.ts';
import { splitHousehold } from '../components/together/household.ts';
import { MonthlySession } from '../components/together/MonthlySession.tsx';
import type { QuizPerson } from '../components/together/PartnerQuiz.tsx';
import { TogetherRules } from '../components/together/rules.tsx';
import {
  isSessionId,
  joinLive,
  openLive,
  runPlanOf,
  SESSION_TITLES,
  sessionSteps,
  useLiveInvite,
  useLiveRun,
  type SessionStep,
} from '../components/together/session.ts';
import { SessionA, type SessionProps } from '../components/together/SessionA.tsx';
import { SessionB } from '../components/together/SessionB.tsx';
import { SessionC } from '../components/together/SessionC.tsx';
import '../components/together/together.css';
import { Icon, ProgressBar, Screen, TopBar } from '../components/ui.tsx';
import { loadRolePlays, loadUnits } from '../lib/data.ts';
import { dayKey } from '../lib/db.ts';
import { useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import type { RolePlay, TogetherWeekPlan, UnitSpec } from '../lib/types.ts';
import { creditTogetherSession } from '../srs/habits.ts';
import { loadWeekPlan } from '../srs/together.ts';
import { uuid } from '../sync/outbox.ts';
import { usePresence, useServerStatus } from '../sync/socket.ts';
import { useHousehold } from '../sync/stats.ts';
import { postTogetherEvent, useTogetherState } from '../sync/together.ts';

/** Credited minutes are capped, in case a phone was left open. */
const MAX_SESSION_MINUTES = 120;

export const STEP_LABELS: Record<SessionStep, string> = {
  quiz: 'Partner quiz',
  'teach-me': 'Teach me',
  conversation: 'Conversation',
  task: 'Task card',
  plan: 'Silent planning',
  run: 'Run the task',
  swap: 'Swap roles',
  outcome: 'Outcome',
  recap: 'Private recap',
  roleplay: 'Role-play',
  story: 'Story talk',
  retell: '4/3/2 retell',
  dictation: 'Dictation',
  showcase: 'Showcase',
  checkin: 'Check-in',
  goal: 'Goal',
  capstone: 'Capstone',
  done: 'Done',
};

export default function TogetherSession() {
  const { id } = useParams();
  if (!isSessionId(id)) {
    return (
      <Screen label="Together session">
        <TopBar back="/together" title="Together" />
        <div className="tg-notice-card" role="alert">
          <h2>There's no such session</h2>
          <Link className="btn secondary small" to="/together">Back to Together</Link>
        </div>
      </Screen>
    );
  }
  return <SessionRoute key={id} session={id} />;
}

interface Loaded {
  weekPlan: TogetherWeekPlan;
  units: UnitSpec[];
  roleplays: RolePlay[];
}

function useSessionData(partnerProgress: MemberProgress | null | undefined) {
  const { state } = useTogetherState();
  const [loaded, setLoaded] = useState<Loaded | { error: true }>();
  const stateKey = state ? JSON.stringify([state.stages, state.tasks.length, state.capstones.length, state.slots]) : '';
  const partnerKey = partnerProgress ? JSON.stringify(partnerProgress) : '';
  useEffect(() => {
    let alive = true;
    Promise.all([
      loadWeekPlan({ state, partner: partnerProgress ?? undefined }),
      loadUnits().catch(() => [] as UnitSpec[]),
      loadRolePlays().catch(() => [] as RolePlay[]),
    ]).then(
      ([weekPlan, units, roleplays]) => { if (alive) setLoaded({ weekPlan, units, roleplays }); },
      () => { if (alive) setLoaded((l) => l ?? { error: true }); },
    );
    return () => { alive = false; };
  }, [stateKey, partnerKey]);
  return loaded;
}

function SessionRoute({ session }: { session: TogetherSessionId }) {
  const settings = useSettings();
  const settingsLoaded = useSettingsLoaded();
  const household = useHousehold();
  const split = splitHousehold(household.data);
  const status = useServerStatus();
  const online = status === 'online';
  const data = useSessionData(split.partner?.progress);
  const aiOn = useAiAvailable(online);
  const presence = usePresence(split.partner?.member.id);
  const invite = useLiveInvite(session);
  const [run, setRun] = useState<{ live: TogetherLiveState; duo: boolean; key: number }>();

  const me: QuizPerson = { id: settings.memberId ?? 'me', name: split.me?.member.name || settings.name || 'You' };
  const partner: QuizPerson = { id: split.partner?.member.id ?? 'partner', name: split.partner?.member.name || 'Your partner' };
  const title = `Session ${session === 'monthly' ? '' : session}`.trim();
  const heading = session === 'monthly' ? SESSION_TITLES.monthly : `${title} · ${SESSION_TITLES[session]}`;

  if (!settingsLoaded || !data) {
    return (
      <Screen label={heading}>
        <TopBar back="/together" title={heading} heading={false} />
        <div className="tg-skeleton-block tg-tall" aria-busy="true" aria-label="Getting the session ready" />
      </Screen>
    );
  }
  if ('error' in data) {
    return (
      <Screen label={heading}>
        <TopBar back="/together" title={heading} />
        <div className="tg-notice-card" role="alert">
          <h2>This session couldn't be prepared</h2>
          <p>Something went wrong reading this week's plan on this phone.</p>
          <Link className="btn secondary small" to="/together">Back to Together</Link>
        </div>
      </Screen>
    );
  }

  const paired = Boolean(settings.deviceToken);
  const duoAvailable = paired && online && Boolean(split.partner) && presence !== false;

  if (!run) {
    const plan = runPlanOf(data.weekPlan);
    const steps = sessionSteps(session, plan);
    const start = (duo: boolean) => setRun({
      duo,
      key: Date.now(),
      live: openLive({ sessionId: uuid(), session, me: me.id, plan, steps, waiting: duo }),
    });
    return (
      <Setup heading={heading} steps={steps} duoAvailable={duoAvailable} paired={paired} online={online}
        hasPartner={Boolean(split.partner)} presence={presence} partnerName={partner.name}
        invite={invite && invite.memberId === partner.id ? () => setRun({ duo: true, key: Date.now(), live: joinLive(invite.state) }) : undefined}
        onStart={start} />
    );
  }

  return (
    <Running key={run.key} initial={run.live} duo={run.duo} me={me} partner={partner}
      partnerProgress={split.partner?.progress ?? null} online={online} aiOn={aiOn} heading={heading}
      loaded={data} ownSlots={settings.togetherSlots}
      onSolo={(live) => setRun({ duo: false, key: Date.now(), live: { ...live, status: 'active', opener: me.id, turn: me.id } })}
      onJoin={(remote) => setRun({ duo: true, key: Date.now(), live: joinLive(remote) })} />
  );
}

function Setup({ heading, steps, duoAvailable, paired, online, hasPartner, presence, partnerName, invite, onStart }: {
  heading: string;
  steps: SessionStep[];
  duoAvailable: boolean;
  paired: boolean;
  online: boolean;
  hasPartner: boolean;
  presence: boolean | undefined;
  partnerName: string;
  invite?: () => void;
  onStart(duo: boolean): void;
}) {
  const id = useId();
  // Two phones by default whenever they are possible (the connection may come up after this
  // screen opens), until the couple picks one.
  const [duo, setDuo] = useState<boolean>();
  const chosen = duoAvailable && (duo ?? true);
  const duoNote = !paired ? 'Connect to your home server on the Together tab first.'
    : !online ? "You're offline right now."
      : !hasPartner ? "Your partner hasn't joined the household yet."
        : presence === false ? `${partnerName} is offline right now.`
          : invite ? `${partnerName} is already in. Join them above.`
            : `${partnerName} opens this session on their phone too.`;
  return (
    <Screen label={heading}>
      <TopBar back="/together" title="Together" heading={false} />
      <header className="tg-rp-head">
        <p className="tg-eyebrow" lang="ja">いっしょに</p>
        <h1 className="tg-together-title">{heading}</h1>
        <ol className="tg-session-steps">
          {steps.filter((s) => s !== 'done').map((s) => <li key={s}>{STEP_LABELS[s]}</li>)}
        </ol>
      </header>

      {invite && (
        <div className="tg-invite-card" role="status">
          <p><strong>{partnerName} started this session.</strong> Join on this phone.</p>
          <button type="button" className="btn indigo block" onClick={invite}>Join {partnerName}</button>
        </div>
      )}

      <fieldset className="tg-option-group">
        <legend className="label">How do you want to do it?</legend>
        <label className={duoAvailable ? 'tg-option-card' : 'tg-option-card tg-disabled'}>
          <input type="radio" name="session-mode" checked={chosen} disabled={!duoAvailable}
            aria-labelledby={`${id}-duo`} aria-describedby={`${id}-duo-note`} onChange={() => setDuo(true)} />
          <span className="tg-option-text">
            <strong id={`${id}-duo`}>Two phones</strong>
            <span id={`${id}-duo-note`} className="muted">{duoNote}</span>
          </span>
        </label>
        <label className="tg-option-card">
          <input type="radio" name="session-mode" checked={!chosen}
            aria-labelledby={`${id}-pass`} aria-describedby={`${id}-pass-note`} onChange={() => setDuo(false)} />
          <span className="tg-option-text">
            <strong id={`${id}-pass`}>One phone</strong>
            <span id={`${id}-pass-note`} className="muted">Pass it back and forth. Works offline.</span>
          </span>
        </label>
      </fieldset>

      <button type="button" className="btn primary block" onClick={() => onStart(chosen)}>
        {chosen ? 'Start together' : 'Start'}
      </button>
    </Screen>
  );
}

function Running({ initial, duo, me, partner, partnerProgress, online, aiOn, heading, loaded, ownSlots, onSolo, onJoin }: {
  initial: TogetherLiveState;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  partnerProgress: MemberProgress | null;
  online: boolean;
  aiOn: boolean;
  heading: string;
  loaded: Loaded;
  ownSlots: readonly TogetherSlot[];
  onSolo(live: TogetherLiveState): void;
  onJoin(remote: TogetherLiveState): void;
}) {
  const run = useLiveRun(initial, { duo, me: me.id });
  const { live, steps } = run;
  const startedAt = useRef(Date.now());
  const invite = useLiveInvite(live.session, live.sessionId);

  // Both phones opened the session at once: the later session joins the earlier one.
  useEffect(() => {
    if (!duo || live.status !== 'waiting' || live.opener !== me.id || !invite) return;
    if (invite.memberId === partner.id && invite.state.sessionId < live.sessionId) onJoin(invite.state);
  }, [duo, live.status, invite]);

  useEffect(() => {
    if (live.status === 'active' && initial.status === 'waiting') startedAt.current = Date.now();
  }, [live.status]);

  if (live.status === 'waiting') {
    return (
      <Screen label={heading}>
        <TopBar back="/together" title={heading} heading={false} />
        <div className="tg-rp-waiting card" role="status">
          <span className="tg-pulse tg-big" aria-hidden="true" />
          <h1>Waiting for {partner.name}…</h1>
          <p>On {partner.name}'s phone: open Together, then this session. It will offer to join you.</p>
          {!online && <p className="tg-say-note">You're offline right now. We'll keep trying.</p>}
        </div>
        <button type="button" className="btn secondary block" onClick={() => onSolo(live)}>Do it on one phone instead</button>
        <Link className="btn ghost block" to="/together">Cancel</Link>
      </Screen>
    );
  }

  if (live.step === 'done') {
    return <Finish session={live.session} startedAt={startedAt.current} heading={heading} partnerName={partner.name} />;
  }

  const props: SessionProps = {
    run,
    plan: live.plan ?? {},
    weekPlan: loaded.weekPlan,
    ownSlots,
    duo,
    me,
    partner,
    partnerProgress,
    online,
    aiOn,
    units: loaded.units,
    roleplays: loaded.roleplays,
  };
  const at = Math.max(0, steps.indexOf(live.step as SessionStep));
  const Body = live.session === 'A' ? SessionA : live.session === 'B' ? SessionB : live.session === 'C' ? SessionC : MonthlySession;

  return (
    <Screen label={heading}>
      <TopBar close="/together" heading={false}
        title={<ProgressBar value={at / Math.max(1, steps.length - 1)} label="Session progress" />}
        right={<span className="tg-rp-count">{STEP_LABELS[live.step as SessionStep] ?? ''}</span>} />
      <h1 className="visually-hidden">{heading}</h1>
      {at === 0 && <TogetherRules />}
      {duo && (
        <p className={online ? 'tg-rp-duo' : 'tg-rp-duo tg-offline'}>
          {online ? <>With {partner.name}</> : <><Icon name="cloudOff" size={16} /> Connection lost. Carry on; you'll sync when it's back.</>}
        </p>
      )}
      <Body {...props} />
    </Screen>
  );
}

/** The end: credit the session once for today (both partners; repeats are harmless). */
function Finish({ session, startedAt, heading, partnerName }: {
  session: TogetherSessionId;
  startedAt: number;
  heading: string;
  partnerName: string;
}) {
  const credited = useRef(false);
  const [minutes] = useState(() => Math.min(MAX_SESSION_MINUTES, Math.max(1, Math.round((Date.now() - startedAt) / 60_000))));
  useEffect(() => {
    if (credited.current) return;
    credited.current = true;
    const date = dayKey();
    void postTogetherEvent({ type: 'session-done', session, date, minutes });
    void creditTogetherSession(session, minutes, date).catch(() => {});
  }, []);
  return (
    <Screen label={heading}>
      <TopBar close="/together" title={heading} heading={false} />
      <div className="tg-rp-done">
        <p className="tg-eyebrow" lang="ja">おつかれさま</p>
        <h1 className="tg-together-title">Session done</h1>
        <p>{minutes} {minutes === 1 ? 'minute' : 'minutes'} together with {partnerName}. It counts as today's minimum for both of you.</p>
      </div>
      <Link className="btn primary block" to="/together">Back to Together</Link>
    </Screen>
  );
}
