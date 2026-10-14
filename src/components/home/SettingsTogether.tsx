// Settings: the home-server connection, the household, and the AI helper.
import { useEffect, useState } from 'react';
import type { Settings } from '../../lib/types.ts';
import { health, isPairedSettings, unpair } from '../../sync/client.ts';
import { useServerStatus, type ServerStatus } from '../../sync/socket.ts';
import { refreshHousehold, resetHousehold, useHousehold } from '../../sync/stats.ts';
import { ConnectServerForm } from '../together/ConnectServerForm.tsx';
import { SettingsSection } from './SettingsStudy.tsx';

const STATUS: Record<ServerStatus, string> = {
  online: 'Online',
  connecting: 'Connecting…',
  offline: 'Offline',
  unpaired: 'Not connected',
};

type AiState = 'checking' | 'on' | 'off' | 'unknown';

function useAiStatus(serverUrl: string | undefined, online: boolean): AiState {
  const [ai, setAi] = useState<AiState>('checking');
  useEffect(() => {
    let live = true;
    setAi('checking');
    health(serverUrl).then(
      (h) => { if (live) setAi(h.aiEnabled ? 'on' : 'off'); },
      () => { if (live) setAi('unknown'); },
    );
    return () => { live = false; };
  }, [serverUrl, online]);
  return ai;
}

const AI_TEXT: Record<AiState, string> = {
  checking: 'Checking…',
  on: 'On: private tips on your messages and “how do I say…?” help.',
  off: 'Off. Add an Anthropic API key on the home server to turn it on.',
  unknown: "Can't check right now. It shows once the home server is reachable.",
};

function Paired({ settings }: { settings: Settings }) {
  const status = useServerStatus();
  const { data } = useHousehold();
  const ai = useAiStatus(settings.serverUrl, status === 'online');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    setBusy(true);
    try {
      await unpair();
      resetHousehold();
    } finally {
      setBusy(false);
      setConfirming(false);
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
                <span>{m.member.name}</span>
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
            <p id="set-unpair-title" className="hm-field-label">Disconnect this phone?</p>
            <p className="hm-hint">
              Your progress stays on this phone. To reconnect later you'll need the household code.
            </p>
            <div className="set-confirm-actions">
              <button type="button" className="btn primary small" onClick={() => void disconnect()} disabled={busy}>
                Disconnect
              </button>
              <button type="button" className="btn secondary small" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn secondary small set-danger" onClick={() => setConfirming(true)}>
            Disconnect this phone
          </button>
        )}
      </div>
    </>
  );
}

export function TogetherSection({ settings }: { settings: Settings }) {
  return (
    <SettingsSection id="set-together" title="Together">
      {isPairedSettings(settings) ? (
        <Paired settings={settings} />
      ) : (
        <div className="set-row">
          <p className="hm-hint set-intro">
            Connect to your home server to see each other's progress, chat in Japanese and quiz each other.
          </p>
          <ConnectServerForm compact onConnected={() => void refreshHousehold()} />
        </div>
      )}
    </SettingsSection>
  );
}
