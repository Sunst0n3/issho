// The chat composer: "you know" kanji chips, the message field, hold-to-record, and send.
//
// With the AI helper on, a message gets a two-step tip before it goes, like the output step:
// first the helper points at up to two problems without fixing them (the learner edits once),
// then it shows the corrected text as a diff with a one-line rule. Sending is never blocked,
// offline included. A reply to the partner's "today's sentence" counts as this member's output
// for the day while today's output step is still open.

import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import type { AiCheckRequest, AiCheckResponse, AiLearnerContext } from '../../../shared/api.ts';
import { loadWordInfo } from '../../lib/data.ts';
import { db, dayKey } from '../../lib/db.ts';
import type { OutputTarget } from '../../lib/types.ts';
import { micAvailable } from '../../speech/recorder.ts';
import { logEncounters } from '../../srs/encounters.ts';
import { completeOutputCheck, learnerAiContext, saveOutput } from '../../srs/output.ts';
import { finishStep } from '../../srs/planner.ts';
import type { ChatItem } from '../../sync/chat.ts';
import { aiCheck, aiReport, ApiError } from '../../sync/client.ts';
import { queueChatMessage } from '../../sync/outbox.ts';
import { Icon, Ruby } from '../ui.tsx';
import { AI_BROKEN_NOTICE, aiProblemOf, markAiBroken, TIMED_OUT, withTimeout, type AiProblem } from './ai.ts';
import { DiffText, IssueList, IssueText } from './DiffText.tsx';
import { TIcon } from './icons.tsx';
import { MicButton } from './MicButton.tsx';
import { TranslateSheet } from './TranslateSheet.tsx';

/** After this long the check is abandoned and the message can go as written. */
export const CHECK_TIMEOUT_MS = 10_000;
/** The home server rejects longer messages for good. */
export const MAX_MESSAGE_LENGTH = 2000;
/** At most this many issues are shown, whatever the server sends. */
export const MAX_ISSUES = 2;

export interface ComposerHandle {
  /** Inserts text at the cursor (or the end). */
  insert(text: string): void;
}

type Tip =
  /** Step 1: the problems are marked in the learner's text; no fix yet. */
  | { stage: 'prompt'; first: string; check: AiCheckResponse }
  /** Step 2, after the learner's own edit: the corrected text, the diff and the rule. */
  | { stage: 'reveal'; first: string; edited: string; check: AiCheckResponse };

/**
 * The output target of a reply: the first word in it (by position) that this learner has been
 * introduced to. '' when there is none (the reply still counts; there is just no word to log).
 */
export async function replyTarget(text: string): Promise<OutputTarget> {
  const [items, info] = await Promise.all([
    db.items.where('kind').anyOf('core', 'word').primaryKeys(),
    loadWordInfo().catch(() => () => undefined),
  ]);
  let best: { at: number; length: number; target: OutputTarget } | undefined;
  for (const id of items as string[]) {
    const word = info(id);
    if (!word) continue;
    for (const form of new Set([word.written, word.kana])) {
      // A single kana is too likely to be part of another word.
      if (!form || (form.length < 2 && form === word.kana)) continue;
      const at = text.indexOf(form);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && form.length > best.length)) {
        best = { at, length: form.length, target: { ref: id, label: word.written, en: word.en } };
      }
    }
  }
  return best?.target ?? { ref: '', label: '', en: '' };
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
  /** The partner's "today's sentence" this message replies to. */
  replyTo?: ChatItem;
  onCancelReply?(): void;
  /** Today's output step is not done yet: a reply to the partner's daily sentence counts as it. */
  outputOpen?: boolean;
  /** Settings.justShowMe: skip the find-it-yourself step. */
  justShowMe?: boolean;
  /** The kana sprint is on (the translate sheet may show romaji). */
  inSprint?: boolean;
}>(function Composer({
  online, aiOn, onAiOff, knownKanji, recentKanji, context, rubyShow,
  replyTo, onCancelReply, outputOpen = false, justShowMe = false, inSprint = false,
}, ref) {
  const id = useId();
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [tip, setTip] = useState<Tip>();
  const [reported, setReported] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [translating, setTranslating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const checkRun = useRef(0);
  const learner = useRef<AiLearnerContext>();
  /** The output reply flow: what the learner first wrote, and the reveal result once there is one. */
  const firstDraft = useRef<string>();
  const revealed = useRef<AiCheckResponse>();
  const countsAsOutput = Boolean(replyTo && outputOpen);

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

  const reset = () => {
    setText('');
    setTip(undefined);
    setReported(false);
    firstDraft.current = undefined;
    revealed.current = undefined;
  };

  /** Records the reply as today's output: saved, its word logged, checked when possible, step done. */
  const recordOutput = async (body: string, chatClientId: string, draft: string, result: AiCheckResponse | undefined) => {
    const target = await replyTarget(body);
    const check = result ? 'pending' : !online ? 'pending' : aiOn ? 'pending' : 'unavailable';
    const rec = await saveOutput({
      day: dayKey(),
      target,
      draft,
      text: body,
      check,
      chatClientId,
      // A reveal shown in the composer was already seen: the next session does not show it again.
      ...(result ? { issues: result.issues.slice(0, MAX_ISSUES), corrected: result.corrected, rule: result.rule, resultSeen: true } : {}),
    });
    if (target.ref) await logEncounters([target.ref], 'output');
    // The card guard decides whether the correction becomes a card; without a reveal yet, the
    // check stays pending and is finished when the server is reachable.
    if (result) await completeOutputCheck(rec.id, result);
    await finishStep('output');
  };

  const deliver = async (body: string) => {
    if (!body) return;
    const asOutput = countsAsOutput;
    // What the output record needs, taken before the composer forgets it.
    const draft = firstDraft.current ?? body;
    const result = revealed.current;
    reset();
    let clientId: string;
    try {
      clientId = await queueChatMessage(asOutput ? { kind: 'text', text: body, tag: 'daily' } : { kind: 'text', text: body });
    } catch {
      setText(body);
      setNotice("Your message couldn't be saved. Try again.");
      return;
    }
    if (asOutput) {
      onCancelReply?.();
      try {
        await recordOutput(body, clientId, draft, result);
        setNotice("That counts as today's sentence.");
      } catch {
        setNotice('Sent. Today’s sentence couldn’t be recorded on this phone.');
      }
    }
  };

  const ask = async (req: AiCheckRequest): Promise<AiCheckResponse | undefined> => {
    const run = ++checkRun.current;
    setChecking(true);
    let result: AiCheckResponse | typeof TIMED_OUT | undefined;
    let broken: AiProblem | undefined;
    try {
      learner.current ??= await learnerAiContext().catch(() => ({ knownKanji }));
      result = await withTimeout(aiCheck({ ...learner.current, ...req, context: context.slice(-6) }), CHECK_TIMEOUT_MS);
    } catch (e) {
      broken = aiProblemOf(e);
      if (broken) {
        // A refused key (or the API failing) won't fix itself: say so once, then stop checking.
        markAiBroken(broken);
        onAiOff();
      } else if (e instanceof ApiError && e.code === 'ai_disabled') {
        onAiOff();
      }
    }
    if (broken) setNotice(AI_BROKEN_NOTICE[broken]);
    // "Send now" was tapped while the helper was still thinking.
    if (run !== checkRun.current) return undefined;
    setChecking(false);
    return result && result !== TIMED_OUT ? result : undefined;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || checking) return;
    setNotice(undefined);
    if (!aiOn || !online || tip?.stage === 'reveal') {
      await deliver(body);
      return;
    }
    if (!tip) {
      firstDraft.current = body;
      if (justShowMe) {
        const check = await ask({ text: body, mode: 'reveal' });
        if (check && !check.ok) {
          revealed.current = check;
          setTip({ stage: 'reveal', first: body, edited: body, check });
          return;
        }
        if (check) revealed.current = check;
        await deliver(body);
        return;
      }
      const check = await ask({ text: body, mode: 'prompt' });
      if (check && !check.ok && check.issues.length > 0) {
        setTip({ stage: 'prompt', first: body, check });
        return;
      }
      await deliver(body);
      return;
    }
    // Step 2: the learner edited once; show the answer.
    const check = await ask({ text: body, mode: 'reveal', firstAttempt: tip.first });
    if (check && !check.ok) {
      revealed.current = check;
      setTip({ stage: 'reveal', first: tip.first, edited: body, check });
      return;
    }
    if (check) revealed.current = check;
    await deliver(body);
  };

  const sendNow = () => {
    checkRun.current++;
    setChecking(false);
    void deliver(text.trim());
  };

  const applyFix = () => {
    if (tip?.stage !== 'reveal') return;
    setText(tip.check.corrected);
    input.current?.focus();
  };

  const report = () => {
    if (!tip || reported) return;
    setReported(true);
    void aiReport({ kind: 'check', text: tip.stage === 'reveal' ? tip.edited : tip.first, issue: tip.check.issues[0] }).catch(() => {});
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // Enter also confirms a Japanese IME conversion; only a bare Enter sends.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  const canRecord = micAvailable() && !countsAsOutput;
  const issues = tip?.check.issues.slice(0, MAX_ISSUES) ?? [];
  const sendLabel = tip?.stage === 'prompt' ? 'Check again' : 'Send';

  return (
    <div className="tg-composer">
      {tip && (
        <section className="tg-tip-panel" aria-labelledby={`${id}-tip`}>
          <p className="tg-tip-head" id={`${id}-tip`}>
            <Icon name="bulb" size={18} />
            {tip.stage === 'prompt' ? 'Take another look before you send' : 'Here is a natural way to say it'}
          </p>
          {tip.stage === 'prompt' ? (
            <>
              <IssueText text={tip.first} issues={issues} />
              <IssueList issues={issues} />
              <p className="muted tg-small">Fix it in the box below, then check again.</p>
            </>
          ) : (
            <>
              <DiffText diff={tip.check.diff} />
              <p className="tg-tip-fixed">
                <span className="label">Natural</span>
                <Ruby text={tip.check.correctedRuby || tip.check.corrected} show={rubyShow} />
              </p>
              {tip.check.rule && <p className="tg-tip-why">{tip.check.rule}</p>}
            </>
          )}
          <p className="tg-tip-private"><TIcon name="eyeOff" size={14} /> Only you can see this tip.</p>
          <div className="tg-button-row">
            {tip.stage === 'reveal' && text.trim() !== tip.check.corrected.trim() && (
              <button type="button" className="btn secondary small" onClick={applyFix}>Use the fix</button>
            )}
            {tip.stage === 'prompt' && (
              <button type="button" className="btn ghost small" onClick={() => void deliver(text.trim() || tip.first)}>
                Send as it is
              </button>
            )}
            <button type="button" className="tg-link-btn" disabled={reported} onClick={report}>
              {reported ? 'Thanks, noted' : 'This tip seems wrong'}
            </button>
          </div>
        </section>
      )}

      {notice && <p className="tg-composer-notice" role="status">{notice}</p>}

      {replyTo && (
        <p className="tg-reply-bar">
          <span className="label">{countsAsOutput ? "Replying to today's sentence · counts as yours" : 'Replying'}</span>
          <span lang="ja" className="tg-reply-text">{replyTo.text}</span>
          <button type="button" className="tg-link-btn" onClick={onCancelReply}>Cancel</button>
        </p>
      )}

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
        <button type="submit" className="tg-send-btn" aria-label={sendLabel} disabled={!text.trim() || checking}>
          <Icon name={tip?.stage === 'prompt' ? 'refresh' : 'send'} size={22} />
        </button>
      </form>

      {checking && (
        <p className="tg-composer-checking" role="status">
          <span className="tg-pulse" aria-hidden="true" />
          Checking your message…
          <button type="button" className="tg-link-btn" onClick={sendNow}>Send now</button>
        </p>
      )}

      {aiOn && online && !checking && !tip && (
        <button type="button" className="tg-stuck-link" onClick={() => setTranslating(true)}>
          <TIcon name="translate" size={16} /> Stuck? Type it in English and see how to say it
        </button>
      )}

      {translating && (
        <TranslateSheet knownKanji={knownKanji} showRomaji={inSprint} onClose={() => setTranslating(false)}
          onUse={(japanese) => { setTranslating(false); insert(japanese); }} />
      )}
    </div>
  );
});
