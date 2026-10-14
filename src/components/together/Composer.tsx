// The chat composer: "you know" kanji chips, the message field, hold-to-record,
// and send. With the AI helper on, a message is looked over before it goes; a
// tip shows privately and the learner chooses the fix or their own version.

import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import type { AiCheckResponse } from '../../../shared/api.ts';
import { micAvailable } from '../../speech/recorder.ts';
import { aiCheck, ApiError } from '../../sync/client.ts';
import { queueChatMessage } from '../../sync/outbox.ts';
import { Icon, Ruby } from '../ui.tsx';
import { TIMED_OUT, withTimeout } from './ai.ts';
import { TIcon } from './icons.tsx';
import { MicButton } from './MicButton.tsx';
import { TranslateSheet } from './TranslateSheet.tsx';

/** After this long the check is abandoned and the message goes as written. */
export const CHECK_TIMEOUT_MS = 10_000;
/** The home server rejects longer messages for good. */
export const MAX_MESSAGE_LENGTH = 2000;

export interface ComposerHandle {
  /** Inserts text at the cursor (or the end). */
  insert(text: string): void;
}

interface Tip {
  original: string;
  check: AiCheckResponse;
}

export const Composer = forwardRef<ComposerHandle, {
  /** The home server is reachable right now. */
  online: boolean;
  /** The AI helper is on (checks before sending, English → Japanese). */
  aiOn: boolean;
  /** Called when the server turns out to have the helper off after all. */
  onAiOff(): void;
  knownKanji: string[];
  /** Most recently learned kanji, newest first. */
  recentKanji: string[];
  /** The last few chat lines, oldest first, for the helper's context. */
  context: string[];
  rubyShow: 'all' | 'none' | ((base: string) => boolean);
}>(function Composer({ online, aiOn, onAiOff, knownKanji, recentKanji, context, rubyShow }, ref) {
  const id = useId();
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [tip, setTip] = useState<Tip>();
  /** Text the helper already fixed: it goes without another check. */
  const [approved, setApproved] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [translating, setTranslating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const checkRun = useRef(0);

  const insert = (piece: string) => {
    // The message being checked is the one that will be sent; edits would be lost.
    if (checking) return;
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText((text.slice(0, start) + piece + text.slice(end)).slice(0, MAX_MESSAGE_LENGTH));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + piece.length, start + piece.length);
    });
  };
  useImperativeHandle(ref, () => ({ insert }));

  const deliver = async (body: string) => {
    if (!body) return;
    setText('');
    setTip(undefined);
    setApproved(undefined);
    try {
      await queueChatMessage({ kind: 'text', text: body });
    } catch {
      setText(body);
      setNotice("Your message couldn't be saved. Try again.");
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || checking) return;
    setNotice(undefined);
    if (aiOn && online && body !== approved) {
      const run = ++checkRun.current;
      setChecking(true);
      let result: AiCheckResponse | typeof TIMED_OUT | undefined;
      try {
        result = await withTimeout(aiCheck({ text: body, knownKanji, context: context.slice(-6) }), CHECK_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'ai_disabled') onAiOff();
      }
      // "Send now" was tapped while the helper was still thinking.
      if (run !== checkRun.current) return;
      setChecking(false);
      if (result && result !== TIMED_OUT && !result.ok && (result.tips.length > 0 || result.corrected.trim() !== body)) {
        setTip({ original: body, check: result });
        return;
      }
    }
    await deliver(body);
  };

  const sendNow = () => {
    checkRun.current++;
    setChecking(false);
    void deliver(text.trim());
  };

  const applyFix = () => {
    if (!tip) return;
    setText(tip.check.corrected);
    setApproved(tip.check.corrected.trim());
    setTip(undefined);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // Enter also confirms a Japanese IME conversion; only a bare Enter sends.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  const canRecord = micAvailable();

  return (
    <div className="tg-composer">
      {tip && (
        <section className="tg-tip-panel" aria-labelledby={`${id}-tip`}>
          <p className="tg-tip-head" id={`${id}-tip`}><Icon name="bulb" size={18} /> A quick tip before you send</p>
          {tip.check.tips.length > 0 && (
            <ul className="tg-tip-list">
              {tip.check.tips.map((t, i) => (
                <li key={i}>
                  <p className="tg-tip-change">
                    <span lang="ja" className="tg-tip-original">{t.original}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="visually-hidden"> could be </span>
                    <span lang="ja" className="tg-tip-suggestion">{t.suggestion}</span>
                  </p>
                  <p className="tg-tip-why">{t.explanation}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="tg-tip-fixed">
            <span className="label">Fixed</span>
            <Ruby text={tip.check.correctedRuby || tip.check.corrected} show={rubyShow} />
          </p>
          <p className="tg-tip-private"><TIcon name="eyeOff" size={14} /> Only you can see this tip.</p>
          <div className="tg-button-row">
            <button type="button" className="btn secondary small" onClick={applyFix}>Use the fix</button>
            <button type="button" className="btn ghost small" onClick={() => void deliver(text.trim() || tip.original)}>
              Send mine anyway
            </button>
          </div>
        </section>
      )}

      {notice && <p className="tg-composer-notice" role="status">{notice}</p>}

      {recentKanji.length > 0 && (
        <div className="tg-known-chips">
          <span className="label" id={`${id}-known`}>You know</span>
          <div className="tg-chip-scroll" role="group" aria-labelledby={`${id}-known`}>
            {recentKanji.map((k) => (
              <button key={k} type="button" className="tg-kanji-chip" lang="ja" aria-label={`Insert ${k}`}
                disabled={checking} onClick={() => insert(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="tg-composer-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input ref={input} className="tg-composer-input" lang="ja" value={text} readOnly={checking}
          maxLength={MAX_MESSAGE_LENGTH} aria-label="Message in Japanese" placeholder="Write in Japanese" enterKeyHint="send" autoComplete="off"
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        {canRecord && (
          <MicButton disabled={checking} onNotice={setNotice}
            onVoice={(audio, transcript) => {
              queueChatMessage({ kind: 'voice', text: '', transcript: transcript || undefined, audio })
                .catch(() => setNotice("Your voice message couldn't be saved. Try again."));
            }} />
        )}
        <button type="submit" className="tg-send-btn" aria-label="Send" disabled={!text.trim() || checking}>
          <Icon name="send" size={22} />
        </button>
      </form>

      {checking && (
        <p className="tg-composer-checking" role="status">
          <span className="tg-pulse" aria-hidden="true" />
          Checking your message…
          <button type="button" className="tg-link-btn" onClick={sendNow}>Send now</button>
        </p>
      )}

      {aiOn && online && !checking && (
        <button type="button" className="tg-stuck-link" onClick={() => setTranslating(true)}>
          <TIcon name="translate" size={16} /> Stuck? Type it in English and see how to say it
        </button>
      )}

      {translating && (
        <TranslateSheet knownKanji={knownKanji} onClose={() => setTranslating(false)}
          onUse={(japanese) => { setTranslating(false); insert(japanese); }} />
      )}
    </div>
  );
});
