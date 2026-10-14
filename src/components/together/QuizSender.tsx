// "Quiz each other": sends the partner the kanji this learner misses most,
// after showing exactly which ones will go.

import { useId, useState, type ReactNode } from 'react';
import { hardestKanji } from '../../srs/progress.ts';
import { ApiError, createQuiz } from '../../sync/client.ts';
import { Glyph } from '../Glyph.tsx';
import { Icon } from '../ui.tsx';
import { rememberQuiz } from './quizzes.ts';

const QUIZ_SIZE = 5;

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'confirm' | 'sending'; chars: string[] }
  | { kind: 'sent'; chars: string[] }
  | { kind: 'error'; message: string; chars?: string[] };

function sendErrorMessage(e: unknown): string {
  if (navigator.onLine === false || (e instanceof ApiError && (e.code === 'network' || e.code === 'timeout'))) {
    return "Couldn't reach your home server. Try again when you're connected.";
  }
  if (e instanceof ApiError && e.code === 'invalid_recipient') return "Your partner isn't in the household anymore.";
  return "The quiz didn't send. Try again in a moment.";
}

export function QuizSender({ partnerId, partnerName, heading = 'Quiz each other', children }: {
  partnerId?: string;
  partnerName: string;
  heading?: string;
  /** Quiz lists (inbox, results) shown under the sender. */
  children?: ReactNode;
}) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const pick = async () => {
    setPhase({ kind: 'loading' });
    const hard = await hardestKanji(QUIZ_SIZE).catch(() => []);
    setPhase(hard.length ? { kind: 'confirm', chars: hard.map((k) => k.char) } : { kind: 'empty' });
  };

  const send = async (chars: string[]) => {
    if (!partnerId) return;
    if (navigator.onLine === false) {
      setPhase({ kind: 'error', message: sendErrorMessage(null), chars });
      return;
    }
    setPhase({ kind: 'sending', chars });
    try {
      const quiz = await createQuiz({ toMemberId: partnerId, items: chars.map((char) => ({ char })) });
      await rememberQuiz(quiz);
      setPhase({ kind: 'sent', chars });
    } catch (e) {
      setPhase({ kind: 'error', message: sendErrorMessage(e), chars });
    }
  };

  const chars = 'chars' in phase ? phase.chars : undefined;
  const choosing = phase.kind === 'confirm' || phase.kind === 'sending' || (phase.kind === 'error' && chars);

  return (
    <section className="tg-quiz-card" aria-labelledby={`${id}-title`}>
      <div className="tg-quiz-card-head">
        <div>
          <h3 id={`${id}-title`}>{heading}</h3>
          <p>
            {partnerId
              ? `Send ${partnerName} the ${QUIZ_SIZE} kanji you miss most.`
              : 'Once your partner joins, you can send them the kanji you miss most.'}
          </p>
        </div>
        {!choosing && (
          <button type="button" className="btn secondary small" onClick={pick}
            disabled={!partnerId || phase.kind === 'loading'}>
            {phase.kind === 'sent' ? 'Send more' : 'Send'}
          </button>
        )}
      </div>

      {choosing && chars && (
        <div className="tg-quiz-confirm">
          <p>Send {chars.length === 1 ? 'this kanji' : `these ${chars.length} kanji`} to {partnerName}?</p>
          <ul className="tg-kanji-row" aria-label="Kanji in the quiz">
            {chars.map((c) => <li key={c} className="tg-kanji-tile"><Glyph char={c} size={30} /></li>)}
          </ul>
          <div className="tg-button-row">
            <button type="button" className="btn indigo small" onClick={() => send(chars)} disabled={phase.kind === 'sending'}>
              {phase.kind === 'sending' ? 'Sending…' : 'Send quiz'}
            </button>
            <button type="button" className="btn ghost small" onClick={() => setPhase({ kind: 'idle' })}
              disabled={phase.kind === 'sending'}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'empty' && (
        <p className="tg-quiz-note" role="status">Review a few kanji first. The ones you miss most will show up here.</p>
      )}
      {phase.kind === 'sent' && (
        <p className="tg-quiz-note" role="status">
          <Icon name="check" size={16} /> Sent to {partnerName}. Their score shows up here when they finish.
        </p>
      )}
      {phase.kind === 'error' && <p className="tg-quiz-note tg-error" role="alert">{phase.message}</p>}

      {children}
    </section>
  );
}
