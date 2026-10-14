// Joins this phone to the household on the home server. Used by the Together
// tab, the chat screen, onboarding and settings, so its props must stay stable.

import { useId, useRef, useState, type FormEvent } from 'react';
import { useSettings } from '../../lib/hooks.ts';
import { ApiError, INVALID_SERVER_URL_MESSAGE, pair, wasRemoved } from '../../sync/client.ts';
import { connectFromSettings } from '../../sync/socket.ts';
import { pushStats } from '../../sync/stats.ts';
import { Icon } from '../ui.tsx';
import { TIcon } from './icons.tsx';
import './together.css';

const OFFLINE = "You're offline. Join your home Wi-Fi, then try again.";

/** Ends a sentence after `text`, without doubling punctuation it already ends with ("…local." or "…!!"). */
const endSentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Turns a pairing failure into a sentence that says what to do next. */
export function pairErrorMessage(e: unknown, serverUrl = ''): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return OFFLINE;
  if (!(e instanceof ApiError)) return 'Something went wrong. Try again.';
  const address = serverUrl.trim();
  const where = address ? ` at ${address}` : '';
  const notIssho = address
    ? `${address} doesn't look like an Issho home server. Check the address.`
    : "This app wasn't opened from your home server. Add its address under Advanced.";
  switch (e.code) {
    case 'invalid_code':
      return "That household code didn't work. Check it with whoever set up the home server.";
    case 'invalid_server_url':
      return INVALID_SERVER_URL_MESSAGE;
    case 'network':
      return `${endSentence(`Couldn't reach the home server${where}`)} Check it's running and this phone is on the same network.`;
    case 'timeout':
      return `The home server${where} took too long to answer. Check it's running, then try again.`;
    case 'rate_limited':
      return 'Too many tries in a row. Wait a minute, then try again.';
    case 'invalid_request':
      return 'Check your name: up to 40 characters.';
    case 'bad_response':
    case 'not_found':
      return notIssho;
  }
  if (e.status === 404 || e.status === 405) return notIssho;
  if (e.status >= 500) return 'The home server had a problem. Try again in a moment.';
  return `Couldn't connect (${e.code}). Try again.`;
}

export function ConnectServerForm({ onConnected, onSkip, compact }: {
  onConnected(): void;
  onSkip?(): void;
  compact?: boolean;
}) {
  const settings = useSettings();
  const id = useId();
  // null = untouched, so the field follows settings once they load.
  const [name, setName] = useState<string | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const nameValue = name ?? settings.name;
  const serverValue = server ?? settings.serverUrl ?? '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!nameValue.trim()) {
      setError("Add your name so your partner knows it's you.");
      nameRef.current?.focus();
      return;
    }
    if (!code.trim()) {
      setError('Enter the household code from your home server.');
      codeRef.current?.focus();
      return;
    }
    if (navigator.onLine === false) {
      setError(OFFLINE);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await pair({ serverUrl: serverValue, householdCode: code, name: nameValue });
    } catch (err) {
      setError(pairErrorMessage(err, serverValue));
      setBusy(false);
      return;
    }
    void pushStats({ immediate: true });
    await connectFromSettings().catch(() => { /* startSync also reconnects when settings change */ });
    setBusy(false);
    onConnected();
  };

  return (
    <form className={compact ? 'tg-connect-form tg-compact' : 'tg-connect-form'} onSubmit={submit} noValidate aria-busy={busy}>
      {wasRemoved() && (
        <div className="tg-notice-card" role="status">
          <p><strong>This phone was disconnected.</strong> It was removed from your household. Connect again to keep
            chatting and sharing progress. Messages you wrote wait here until then.</p>
        </div>
      )}
      {!compact && (
        <p className="muted">Both phones join with the same household code. It's set on your home server.</p>
      )}
      <div className="tg-field">
        <label htmlFor={`${id}-name`}>Your name</label>
        <input ref={nameRef} id={`${id}-name`} className="text-input" value={nameValue} maxLength={40}
          autoComplete="given-name" onChange={(e) => setName(e.target.value)} aria-describedby={`${id}-name-hint`} />
        <span id={`${id}-name-hint`} className="tg-field-hint">This is how your partner sees you.</span>
      </div>
      <div className="tg-field">
        <label htmlFor={`${id}-code`}>Household code</label>
        <div className="tg-input-with-button">
          <input ref={codeRef} id={`${id}-code`} className="text-input" type={showCode ? 'text' : 'password'}
            value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none"
            autoCorrect="off" spellCheck={false} />
          <button type="button" className="icon-btn" aria-pressed={showCode}
            aria-label={showCode ? 'Hide household code' : 'Show household code'} onClick={() => setShowCode((v) => !v)}>
            {showCode ? <TIcon name="eyeOff" /> : <Icon name="eye" />}
          </button>
        </div>
      </div>
      <details className="tg-advanced" open={Boolean(settings.serverUrl) || undefined}>
        <summary>Advanced: server address</summary>
        <div className="tg-field">
          <label htmlFor={`${id}-server`}>Server address</label>
          <input id={`${id}-server`} className="text-input" value={serverValue} inputMode="url" autoComplete="url"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="192.168.1.20:8787"
            onChange={(e) => setServer(e.target.value)} aria-describedby={`${id}-server-hint`} />
          <span id={`${id}-server-hint`} className="tg-field-hint">
            Leave this empty when you opened Issho from your home server.
          </span>
        </div>
      </details>
      {error && <p className="tg-form-error" role="alert"><TIcon name="alert" size={18} />{error}</p>}
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      {onSkip && (
        <button type="button" className="btn ghost block" onClick={onSkip} disabled={busy}>Not now</button>
      )}
    </form>
  );
}
