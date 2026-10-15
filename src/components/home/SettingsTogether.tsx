// Settings: the together plan (slots, shared goal, sharing accuracy), the home-server connection,
// the household, and the AI helper.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dayKey, updateSettings } from '../../lib/db.ts';
import type { Settings, TogetherSlot } from '../../lib/types.ts';
import { health, isPairedSettings, unpair } from '../../sync/client.ts';
import { useServerStatus, type ServerStatus } from '../../sync/socket.ts';
import { pushStats, refreshHousehold, resetHousehold, useHousehold } from '../../sync/stats.ts';
import { postTogetherEvent } from '../../sync/together.ts';
import { useAiProblem, type AiProblem } from '../together/ai.ts';
import { ConnectServerForm } from '../together/ConnectServerForm.tsx';
import { focusLost } from '../together/focus.ts';
import { Switch } from './controls.tsx';
import { syncMemberName } from './nameSync.ts';
import { completeSlots, goalFromDraft, GoalFields, PartnerRules, SlotsEditor, type GoalDraft } from './planControls.tsx';
import { SettingsSection } from './SettingsStudy.tsx';

const STATUS: Record<ServerStatus, string> = {
  online: 'Online',
  connecting: 'Connecting…',
  offline: 'Offline',
  unpaired: 'Not connected',
};

type AiState = 'checking' | 'on' | 'off' | 'unknown' | AiProblem;

function useAiStatus(serverUrl: string | undefined, online: boolean): AiState {
  const [ai, setAi] = useState<AiState>('checking');
  // The server can say the helper is on while the AI service refuses it: the chat found out.
  const problem = useAiProblem();
  useEffect(() => {
    let live = true;
    setAi('checking');
    health(serverUrl).then(
      (h) => { if (live) setAi(h.aiEnabled ? 'on' : 'off'); },
      () => { if (live) setAi('unknown'); },
    );
    return () => { live = false; };
  }, [serverUrl, online]);
  return ai === 'on' && problem ? problem : ai;
}

const AI_TEXT: Record<AiState, string> = {
  checking: 'Checking…',
  on: 'On: private tips on your messages and “how do I say…?” help.',
  off: 'Off. Add an Anthropic API key on the home server to turn it on.',
  unknown: "Can't check right now. It shows once the home server is reachable.",
  ai_misconfigured: "Not working: the home server's API key (or model) was refused. Check ANTHROPIC_API_KEY on the server.",
  ai_unavailable: 'Not working right now: the AI service is returning errors. Messages send without a check.',
};

function Paired({ settings }: { settings: Settings }) {
  const status = useServerStatus();
  const { data } = useHousehold();
  const ai = useAiStatus(settings.serverUrl, status === 'online');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);

  // The trigger button is replaced by the confirmation: move focus into it, and back on Cancel.
  useEffect(() => {
    if (confirming) confirmTitle.current?.focus();
    else if (reopened.current) trigger.current?.focus();
    reopened.current = confirming;
  }, [confirming]);

  // The server still shows an older name (renamed while offline, or a rename
  // that failed): send the one from Settings.
  const serverName = data?.members.find((m) => m.member.id === data.me)?.member.name;
  const localName = settings.name.trim();
  useEffect(() => {
    if (serverName !== undefined && localName && serverName !== localName) void syncMemberName(localName);
  }, [serverName, localName]);

  // Busy until this section turns into the connect form (unpair() waits up to 3 s for the server).
  const disconnect = async () => {
    setBusy(true);
    try {
      await unpair();
      resetHousehold();
    } catch (e) {
      console.error('disconnect failed', e);
      setBusy(false);
    }
  };

  const me = data?.me ?? settings.memberId;
  return (
    <>
      <div className="set-row set-split">
        <div>
          <p className="hm-field-label">{data?.householdName ?? settings.householdName ?? 'Your household'}</p>
          <p className="hm-hint">Connected to your home server</p>
        </div>
        <span className={`set-status ${status}`} role="status">{STATUS[status]}</span>
      </div>

      <div className="set-row">
        <p className="hm-field-label">Members</p>
        {data ? (
          <ul className="set-members">
            {data.members.map((m) => (
              <li key={m.member.id}>
                <span className="set-avatar" aria-hidden="true">{(m.member.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="set-member-name">{m.member.name}</span>
                {m.member.id === me && <span className="chip ai">This phone</span>}
              </li>
            ))}
            {data.members.length < 2 && <li className="hm-hint">Your partner joins with the same household code.</li>}
          </ul>
        ) : (
          <p className="hm-hint">Members show up once this phone reaches the home server.</p>
        )}
      </div>

      <div className="set-row">
        <p className="hm-field-label">AI helper</p>
        <p className="hm-hint" role="status">{AI_TEXT[ai]}</p>
      </div>

      <div className="set-row">
        {confirming ? (
          <div className="set-confirm" role="group" aria-labelledby="set-unpair-title">
            <p id="set-unpair-title" ref={confirmTitle} tabIndex={-1} className="hm-field-label set-confirm-title">Disconnect this phone?</p>
            <p className="hm-hint">
              Your progress stays on this phone. To reconnect later you'll need the household code.
              Messages that haven't been sent yet wait here and go out when you connect again.
            </p>
            <div className="set-confirm-actions">
              <button type="button" className="btn primary small" onClick={() => void disconnect()} disabled={busy}
                aria-busy={busy}>
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </button>
              <button type="button" className="btn secondary small" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button ref={trigger} type="button" className="btn secondary small set-danger" onClick={() => setConfirming(true)}>
            Disconnect this phone
          </button>
        )}
      </div>
    </>
  );
}

const sameSlots = (a: readonly TogetherSlot[], b: readonly TogetherSlot[]) =>
  a.length === b.length && a.every((s, i) => s.session === b[i].session && s.weekday === b[i].weekday && s.time === b[i].time);

/** The weekly slots and the shared goal. Saved on this phone, and posted to the household when paired. */
function TogetherPlan({ settings }: { settings: Settings }) {
  const saved = completeSlots(settings.togetherSlots);
  const [slots, setSlots] = useState<TogetherSlot[]>(saved);
  const [goal, setGoal] = useState<GoalDraft>(settings.sharedGoal ?? { text: '', targetDate: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const edited = useRef(false);
  // The partner changed the plan (synced into Settings): show theirs unless this phone is mid-edit.
  useEffect(() => {
    if (edited.current) return;
    setSlots(completeSlots(settings.togetherSlots));
    setGoal(settings.sharedGoal ?? { text: '', targetDate: '' });
  }, [settings.togetherSlots, settings.sharedGoal]);
  const paired = isPairedSettings(settings);
  const nextGoal = goalFromDraft(goal);
  const goalChanged = (nextGoal?.text ?? '') !== (settings.sharedGoal?.text ?? '')
    || (nextGoal?.targetDate ?? '') !== (settings.sharedGoal?.targetDate ?? '');
  const changed = !sameSlots(slots, saved) || !settings.togetherSlots.length || goalChanged;

  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await updateSettings({ togetherSlots: slots, sharedGoal: nextGoal });
      if (paired) {
        // Queued while offline, sent in order when the home server is back.
        await postTogetherEvent({ type: 'slots', slots });
        if (nextGoal && goalChanged) await postTogetherEvent({ type: 'goal', goal: nextGoal });
      }
      edited.current = false;
      setMessage({ ok: true, text: paired ? 'Saved, and shared with your partner.' : 'Saved on this phone.' });
    } catch {
      setMessage({ ok: false, text: "Couldn't save that. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="set-row">
        <p className="hm-field-label">Your sessions</p>
        <p className="hm-hint">Three 15-minute sessions a week. Changing them changes them for both of you.</p>
        <SlotsEditor slots={slots} onChange={(s) => { edited.current = true; setMessage(undefined); setSlots(s); }} />
      </div>
      <div className="set-row">
        <GoalFields draft={goal} onChange={(g) => { edited.current = true; setMessage(undefined); setGoal(g); }} min={dayKey()} />
      </div>
      <div className="set-row">
        <button type="button" className="btn secondary small set-save" onClick={() => void save()}
          disabled={busy || !changed} aria-busy={busy}>
          Save sessions and goal
        </button>
        {message && <p className={message.ok ? 'hm-ok' : 'hm-error'} role="status">{message.text}</p>}
      </div>
      <div className="set-row">
        <Switch label="Share my accuracy" hint="Your partner sees how many answers you got right. Off: they see only your effort."
          checked={settings.shareAccuracy}
          onChange={(shareAccuracy) => {
            void updateSettings({ shareAccuracy }).then(() => { if (paired) void pushStats({ immediate: true }); });
          }} />
      </div>
      <div className="set-row">
        <PartnerRules />
      </div>
    </>
  );
}

export function TogetherSection({ settings }: { settings: Settings }) {
  const paired = isPairedSettings(settings);
  // Disconnecting replaces the confirmation with the connect form: keep focus in this section.
  const wasPaired = useRef(paired);
  const intro = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (wasPaired.current && !paired && focusLost()) intro.current?.focus();
    wasPaired.current = paired;
  }, [paired]);
  return (
    <SettingsSection id="set-together" title="Together">
      <TogetherPlan settings={settings} />
      {paired ? (
        <Paired settings={settings} />
      ) : (
        <div className="set-row">
          <p ref={intro} tabIndex={-1} className="hm-hint set-intro">
            Connect to your home server to see each other's progress, chat in Japanese and quiz each other.
          </p>
          <ConnectServerForm compact onConnected={() => void refreshHousehold()} />
        </div>
      )}
    </SettingsSection>
  );
}
