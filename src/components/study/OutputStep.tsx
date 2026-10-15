// Today's sentence to the partner, using a recent word or grammar point. With the home server's AI, a first look
// marks at most two places to check (with a type label, never the fix); the learner edits once, then the correction
// is revealed as a diff with a one-line rule. "Just show me" goes straight to the correction. Sending is never
// blocked: offline or without the AI the sentence goes out and its check waits ('pending') or is skipped.

import { useRef, useState, type ReactNode } from 'react';
import type { AiCheckResponse, AiIssue, AiIssueType } from '../../../shared/api.ts';
import { dayKey, getSettings } from '../../lib/db.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import type { OutputSentenceRecord, OutputTarget } from '../../lib/types.ts';
import { logEncounters } from '../../srs/encounters.ts';
import { completeOutputCheck, learnerAiContext, saveOutput } from '../../srs/output.ts';
import { aiCheck, aiReport, ApiError } from '../../sync/client.ts';
import { queueChatMessage } from '../../sync/outbox.ts';
import { Icon, Ruby } from '../ui.tsx';
import { KanaInput } from './cards/KanaInput.tsx';
import { MixedText } from './MixedText.tsx';

export const ISSUE_LABELS: Record<AiIssueType, string> = {
  particle: 'Particle',
  conjugation: 'Conjugation',
  'word-choice': 'Word choice',
  kanji: 'Kanji',
  register: 'Register',
  other: 'Other',
};

type CheckState = OutputSentenceRecord['check'];
type Stage = 'write' | 'checking' | 'prompt' | 'revealing' | 'reveal' | 'sending' | 'sent';

/** The AI cannot run here (no server, not paired, no key): the check is 'unavailable'. Anything else is retried later. */
function checkStateFor(e: unknown): CheckState {
  if (e instanceof ApiError && ['ai_disabled', 'ai_misconfigured', 'unpaired', 'invalid_server_url'].includes(e.code)) return 'unavailable';
  return 'pending';
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** The learner's text with each issue's span highlighted and labelled; no fix is shown. */
export function MarkedText({ text, issues }: { text: string; issues: readonly AiIssue[] }) {
  const spans = issues
    .map((issue) => {
      const start = issue.start ?? (issue.quote ? text.indexOf(issue.quote) : -1);
      return { issue, start, end: start >= 0 ? (issue.end ?? start + issue.quote.length) : -1 };
    })
    .filter((s) => s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let at = 0;
  spans.forEach(({ issue, start, end }, k) => {
    if (start < at) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={k} className={issue.uncertain ? 'st-issue maybe' : 'st-issue'}>
        {text.slice(start, end)}
        <span className="visually-hidden"> ({ISSUE_LABELS[issue.type]}{issue.uncertain ? ', maybe' : ''})</span>
      </mark>,
    );
    at = end;
  });
  parts.push(text.slice(at));
  return <p className="st-output-text" lang="ja">{parts}</p>;
}

function Diff({ result }: { result: AiCheckResponse }) {
  return (
    <p className="st-output-text st-diff" lang="ja">
      {result.diff.map((op, k) => {
        if (op.op === 'del') return <del key={k}>{op.text}</del>;
        if (op.op === 'ins') return <ins key={k}>{op.text}</ins>;
        return <span key={k}>{op.text}</span>;
      })}
    </p>
  );
}

const isGrammarIssue = (i: AiIssue) => i.type !== 'word-choice';

export function OutputStep({ target, partnerName, onDone }: { target: OutputTarget; partnerName: string; onDone(): void }) {
  const [text, setText] = useState('');
  const [stage, setStage] = useState<Stage>('write');
  const [issues, setIssues] = useState<AiIssue[]>([]);
  const [result, setResult] = useState<AiCheckResponse | null>(null);
  const [edited, setEdited] = useState(false);
  const [reported, setReported] = useState(false);
  const [cardMade, setCardMade] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  /** A word-choice-only flag survived the edit: the correction is fetched but shown only on "Show me". */
  const [held, setHeld] = useState(false);
  const draft = useRef('');
  /** The chat message once queued: a send retried after a failed save reuses it instead of sending twice. */
  const queued = useRef<{ clientId: string; text: string } | null>(null);
  const check = useRef<CheckState>('skipped');
  const busy = useRef(false);
  const targetText = rubyToPlain(target.label);
  const partner = partnerName || 'your partner';

  /** `hold`: after the edit of a word-choice-only flag, a remaining word-choice issue stays a flag until asked. */
  const reveal = async (current: string, hold = false) => {
    setStage('revealing');
    try {
      const context = await learnerAiContext();
      const r = await aiCheck({
        ...context, mode: 'reveal', text: current, target: targetText,
        ...(current !== draft.current ? { firstAttempt: draft.current } : {}),
      });
      check.current = 'done';
      setResult(r);
      setHeld(hold && !r.ok && r.issues.length > 0 && !r.issues.some(isGrammarIssue));
      setStage('reveal');
    } catch (e) {
      check.current = checkStateFor(e);
      setStage('reveal');
    }
  };

  const firstLook = async () => {
    const current = text.trim();
    if (!current || busy.current) return;
    busy.current = true;
    draft.current = current;
    try {
      if (!online()) {
        check.current = 'pending';
        setStage('reveal');
        return;
      }
      // Read now rather than from a hook: the choice must hold even if the screen opened a moment ago.
      if ((await getSettings()).justShowMe) {
        await reveal(current);
        return;
      }
      setStage('checking');
      try {
        const r = await aiCheck({ ...(await learnerAiContext()), mode: 'prompt', text: current, target: targetText });
        if (r.ok || !r.issues.length) {
          // Nothing to find: the reveal still fetches the words the card guard needs.
          await reveal(current);
          return;
        }
        setIssues(r.issues);
        setStage('prompt');
      } catch (e) {
        check.current = checkStateFor(e);
        setStage('reveal');
      }
    } finally {
      busy.current = false;
    }
  };

  const resubmit = () => {
    const current = text.trim();
    if (!current) return;
    setEdited(true);
    // Grammar is revealed after the one edit; word choice only when the learner asks.
    void reveal(current, !issues.some(isGrammarIssue));
  };

  const send = async (choice: string) => {
    if (busy.current) return;
    busy.current = true;
    setStage('sending');
    setSendFailed(false);
    try {
      if (!queued.current) {
        queued.current = { clientId: await queueChatMessage({ kind: 'text', text: choice, tag: 'daily' }), text: choice };
      }
      // Already queued by an earlier try whose save failed: that message is the one sent.
      const { clientId: chatClientId, text: sendText } = queued.current;
      const rec = await saveOutput({
        day: dayKey(),
        target,
        draft: draft.current || sendText,
        text: sendText,
        check: check.current,
        ...(issues.length ? { issues } : {}),
        ...(result ? { corrected: result.correctedRuby || result.corrected, rule: result.rule } : {}),
        chatClientId,
        ...(reported ? { reported: true } : {}),
        // Checked before sending: the learner has seen it. A queued check is shown by the next session.
        ...(check.current === 'done' ? { resultSeen: true } : {}),
      });
      void logEncounters([target.ref], 'output').catch((e: unknown) => console.warn('could not log the encounter', e));
      if (check.current === 'done' && result) {
        const made: { cardId?: string } = await completeOutputCheck(rec.id, result).catch((e: unknown) => {
          console.error('could not finish the check', e);
          return {};
        });
        setCardMade(Boolean(made.cardId));
      }
      setStage('sent');
    } catch (e) {
      console.error('could not send today’s sentence', e);
      setSendFailed(true);
      setStage('reveal');
    } finally {
      busy.current = false;
    }
  };

  const report = (issue?: AiIssue) => {
    setReported(true);
    void aiReport({ kind: 'check', text: draft.current, ...(issue ? { issue } : {}) }).catch((e: unknown) => console.warn('could not send the report', e));
  };

  const prompt = (
    <section className="st-question">
      <p className="label">Today's sentence</p>
      <h2 className="st-ask">
        Tell {partner} something using <Ruby text={target.label} show="all" className="st-output-target" />
      </h2>
      <p className="st-note"><MixedText text={target.en} /></p>
    </section>
  );

  if (stage === 'sent') {
    return (
      <div className="st-output">
        {prompt}
        <div className="feedback good st-feedback" role="status">
          <p className="st-fb-title">Sent to {partner}</p>
          {check.current === 'pending' && <p className="st-fb-note">The check runs when the home server is reachable.</p>}
          {cardMade && <p className="st-fb-note">The corrected sentence is now a card.</p>}
        </div>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }

  const field = (
    <KanaInput value={text} onChange={setText} label="Your sentence" placeholder="Type in romaji or kana"
      readOnly={stage !== 'write' && stage !== 'prompt'} onSubmit={() => (stage === 'write' ? void firstLook() : stage === 'prompt' ? resubmit() : undefined)} />
  );

  if (stage === 'write' || stage === 'checking') {
    return (
      <div className="st-output">
        {prompt}
        {field}
        <p className="st-note">Kana is fine. Kanji are not needed.</p>
        <div className="st-footer">
          <button type="button" className="btn ink st-grow" disabled={!text.trim() || stage === 'checking'} onClick={() => void firstLook()}>
            {stage === 'checking' ? 'Looking…' : 'Check it'}
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'prompt') {
    const grammar = issues.some(isGrammarIssue);
    return (
      <div className="st-output">
        {prompt}
        <MarkedText text={draft.current} issues={issues} />
        <ul className="st-issues">
          {issues.map((issue, k) => (
            <li key={k}>
              <span className="chip shu">{ISSUE_LABELS[issue.type]}{issue.uncertain ? ' · maybe' : ''}</span>
              <span><MixedText text={issue.hint} /></span>
            </li>
          ))}
        </ul>
        <p className="st-note">{grammar ? 'Have one go at fixing it, then see the correction.' : 'A word might fit better. Change it, or see a suggestion.'}</p>
        {field}
        <div className="st-footer">
          {!grammar && (
            <button type="button" className="btn secondary" onClick={() => void reveal(draft.current)}>Show me</button>
          )}
          <button type="button" className="btn ink st-grow" disabled={!text.trim()} onClick={resubmit}>Check again</button>
        </div>
      </div>
    );
  }

  // revealing / reveal / sending
  const corrected = result && !held && !result.ok && rubyToPlain(result.corrected) !== text.trim() ? result.corrected : null;
  const retry = sendFailed ? queued.current : null;
  return (
    <div className="st-output">
      {prompt}
      {stage === 'revealing' && <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Getting the correction" />}
      {stage !== 'revealing' && result && held && (
        <div className="feedback st-feedback" role="status">
          <p className="st-fb-title">A word might still fit better</p>
          <MarkedText text={text.trim()} issues={result.issues} />
          <ul className="st-issues">
            {result.issues.map((issue, k) => (
              <li key={k}><span className="chip shu">{ISSUE_LABELS[issue.type]}{issue.uncertain ? ' · maybe' : ''}</span></li>
            ))}
          </ul>
        </div>
      )}
      {stage !== 'revealing' && result && !held && (
        <div className={result.ok ? 'feedback good st-feedback' : 'feedback st-feedback st-reveal-box'} role="status">
          <p className="st-fb-title">{result.ok ? 'Natural and correct' : edited ? 'Here is the correction' : 'A suggestion'}</p>
          {!result.ok && <Diff result={result} />}
          {result.rule && <p className="st-fb-note"><MixedText text={result.rule} /></p>}
          {!result.ok && (
            <button type="button" className="btn ghost small" disabled={reported} onClick={() => report(result.issues[0])}>
              {reported ? 'Thanks — noted' : 'This tip seems wrong'}
            </button>
          )}
        </div>
      )}
      {stage !== 'revealing' && !result && (
        <p className="card st-note" role="status">
          {check.current === 'pending'
            ? 'Sent without a check for now: it runs when the home server is reachable.'
            : 'The sentence checker needs the home server. Your sentence goes to your partner as it is.'}
        </p>
      )}
      {stage !== 'revealing' && !result && <p className="st-output-text" lang="ja">{text.trim()}</p>}
      {sendFailed && <p className="feedback bad" role="alert">Couldn't save the message on this phone. Try again.</p>}
      {stage !== 'revealing' && (
        <div className="st-footer">
          {retry ? (
            <button type="button" className="btn primary st-grow" disabled={stage === 'sending'} onClick={() => void send(retry.text)}>
              <Icon name="send" size={18} />Try again
            </button>
          ) : held ? (
            <>
              <button type="button" className="btn secondary" disabled={stage === 'sending'} onClick={() => setHeld(false)}>Show me</button>
              <button type="button" className="btn primary st-grow" disabled={stage === 'sending'} onClick={() => void send(text.trim())}>
                <Icon name="send" size={18} />Send mine
              </button>
            </>
          ) : corrected ? (
            <>
              <button type="button" className="btn secondary" disabled={stage === 'sending'} onClick={() => void send(text.trim())}>Send mine</button>
              <button type="button" className="btn primary st-grow" disabled={stage === 'sending'} onClick={() => void send(rubyToPlain(corrected))}>
                <Icon name="send" size={18} />Send the corrected one
              </button>
            </>
          ) : (
            <button type="button" className="btn primary st-grow" disabled={stage === 'sending'} onClick={() => void send(text.trim())}>
              <Icon name="send" size={18} />Send to {partner}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
