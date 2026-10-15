// A can-do performance check (/cando/:id). Read and listen checks are 2–3 questions on real material (a menu, a
// message, an announcement), passed with 2 of 3. Speak and write checks are judged against their rubric by the home
// server's AI only; without it nothing is recorded. A partner never judges. Showcase mode (Session C's season finale)
// replays a check and records nothing.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AiCanDoResponse } from '../../shared/api.ts';
import { clipRef } from '../../shared/voicevox.ts';
import { KanaInput } from '../components/study/cards/KanaInput.tsx';
import { StudyDisplayProvider } from '../components/study/DisplayProvider.tsx';
import { MixedText } from '../components/study/MixedText.tsx';
import { useStudyTimer } from '../components/study/time.ts';
import { useAsync } from '../components/study/useAsync.ts';
import { Icon, Ruby, Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { loadUnits } from '../lib/data.ts';
import { useRubyShow } from '../lib/hooks.ts';
import type { CanDo, UnitSpec } from '../lib/types.ts';
import { canDoAvailable, gradeCanDoQuestions, recordCanDoAttempt } from '../srs/candos.ts';
import { listen, recognitionAvailable, type Listening } from '../speech/recognition.ts';
import { usePlayback } from '../speech/audio.ts';
import { aiCanDo, ApiError } from '../sync/client.ts';
import '../components/study/study.css';

export const NEEDS_SERVER = "Needs the home server — try again when you're connected.";

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** The AI can't judge right now: no server, not paired, no key, offline. */
function serverMissing(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.transient || ['ai_disabled', 'ai_misconfigured', 'unpaired', 'invalid_server_url', 'network', 'timeout'].includes(e.code);
}

function Questions({ canDo, onSubmit }: { canDo: CanDo; onSubmit: (answers: number[]) => void }) {
  const qs = canDo.check.questions;
  const [answers, setAnswers] = useState<(number | null)[]>(() => qs.map(() => null));
  const [submitted, setSubmitted] = useState(false);
  return (
    <>
      {qs.map((q, i) => {
        const picked = answers[i];
        return (
          <section key={i} className="st-question">
            <h3 className="st-ask"><MixedText text={q.q} /></h3>
            <div className="choice-grid st-choices wide" role="radiogroup" aria-label={q.q}>
              {q.options.map((option, k) => (
                <button key={k} type="button" role="radio" aria-checked={picked === k} disabled={submitted}
                  className={`choice${picked === k ? ' selected' : ''}${submitted && k === q.answer ? ' correct' : ''}${submitted && picked === k && k !== q.answer ? ' wrong' : ''}`}
                  onClick={() => setAnswers(answers.map((a, j) => (j === i ? k : a)))}>
                  <MixedText text={option} />
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {!submitted && (
        <div className="st-footer">
          <button type="button" className="btn ink st-grow" disabled={answers.some((a) => a === null)}
            onClick={() => { setSubmitted(true); onSubmit(answers.map((a) => a ?? -1)); }}>Check my answers</button>
        </div>
      )}
    </>
  );
}

function SpeakOrWrite({ canDo, onText }: { canDo: CanDo; onText: (text: string) => void }) {
  const speak = canDo.check.kind === 'speak';
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const current = useRef<Listening | null>(null);
  useEffect(() => () => current.current?.stop(), []);
  const record = () => {
    if (listening) {
      current.current?.stop();
      return;
    }
    const l = listen({ lang: 'ja-JP', timeoutMs: 30_000, interim: setText });
    current.current = l;
    setListening(true);
    l.result.then(
      (heard) => { setListening(false); if (heard) setText(heard); },
      () => setListening(false),
    );
  };
  return (
    <section className="st-question">
      {canDo.check.rubric && (
        <ul className="st-rubric">
          {canDo.check.rubric.map((r) => <li key={r}><MixedText text={r} /></li>)}
        </ul>
      )}
      {speak && recognitionAvailable() && (
        <button type="button" className={listening ? 'btn primary block' : 'btn secondary block'} onClick={record} aria-pressed={listening}>
          <Icon name={listening ? 'stop' : 'mic'} size={18} />{listening ? 'Listening… tap to stop' : 'Speak'}
        </button>
      )}
      <KanaInput value={text} onChange={setText} label={speak ? 'What you said' : 'What you wrote'}
        placeholder={speak ? 'Or type what you would say' : 'Type in romaji or kana'} />
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" disabled={!text.trim() || listening} onClick={() => onText(text.trim())}>Check it</button>
      </div>
    </section>
  );
}

type Outcome =
  | { kind: 'questions'; correct: number; total: number; passed: boolean }
  | { kind: 'ai'; result: AiCanDoResponse }
  | { kind: 'no-server' }
  | { kind: 'error' };

/** One can-do check. `showcase`: a rehearsal (Session C's season finale) that records nothing. */
export function CanDoCheckView({ canDo, unit, showcase = false, onDone }: {
  canDo: CanDo;
  unit: UnitSpec;
  showcase?: boolean;
  onDone?: () => void;
}) {
  const show = useRubyShow();
  const { play } = usePlayback();
  const [heard, setHeard] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const check = canDo.check;

  if (!canDo.ready) {
    return (
      <div className="card st-empty-card">
        <h2>Check coming soon</h2>
        <p className="muted"><MixedText text={canDo.text} /></p>
      </div>
    );
  }

  const record = (passed: boolean, via: 'auto' | 'ai') => {
    if (showcase) return;
    void recordCanDoAttempt(canDo.id, unit.id, passed, via).catch((e: unknown) => console.error('could not record the check', e));
  };

  const answer = (answers: number[]) => {
    const { correct, passed } = gradeCanDoQuestions(canDo, answers);
    record(passed, 'auto');
    setOutcome({ kind: 'questions', correct, total: check.questions.length, passed });
  };

  const judge = async (text: string) => {
    if (!online()) {
      setOutcome({ kind: 'no-server' });
      return;
    }
    setChecking(true);
    try {
      const result = await aiCanDo({ canDoId: canDo.id, kind: check.kind === 'speak' ? 'speak' : 'write', rubric: check.rubric ?? [], text });
      record(result.passed, 'ai');
      setOutcome({ kind: 'ai', result });
    } catch (e) {
      console.warn('can-do check failed', e);
      setOutcome(serverMissing(e) ? { kind: 'no-server' } : { kind: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const listenMaterial = () => {
    setHeard(true);
    void play({ ref: clipRef.canDo(canDo.id) }, { fallbackText: check.material });
  };

  return (
    <div className="st-reading st-cando">
      <header className="st-story-head">
        <p className="label">Unit {unit.id} · can-do{showcase ? ' · showcase' : ''}</p>
        <h2 className="st-story-title"><MixedText text={canDo.text} /></h2>
        <p className="st-note"><MixedText text={check.instructions} /></p>
      </header>

      {check.kind === 'read' && <div className="card st-material"><Ruby text={check.material} show={show} /></div>}
      {check.kind === 'listen' && (
        <div className="card st-prompt">
          <button type="button" className="btn secondary" onClick={listenMaterial}><Icon name="speaker" size={18} />{heard ? 'Play again' : 'Play'}</button>
        </div>
      )}

      {!outcome && (check.kind === 'read' || (check.kind === 'listen' && heard)) && <Questions canDo={canDo} onSubmit={answer} />}
      {!outcome && (check.kind === 'speak' || check.kind === 'write') && (
        checking ? <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Checking" /> : <SpeakOrWrite canDo={canDo} onText={(t) => void judge(t)} />
      )}

      {outcome?.kind === 'questions' && (
        <div className={outcome.passed ? 'feedback good st-feedback' : 'feedback bad st-feedback'} role="status">
          <p className="st-fb-title">{outcome.correct} of {outcome.total} {outcome.passed ? '— you can do this' : '— not yet'}</p>
          {!outcome.passed && <p className="st-fb-note">Try it again another day.</p>}
          {check.kind === 'listen' && <p className="st-fb-note" lang="ja"><Ruby text={check.material} show="all" /></p>}
        </div>
      )}
      {outcome?.kind === 'ai' && (
        <div className={outcome.result.passed ? 'feedback good st-feedback' : 'feedback bad st-feedback'} role="status">
          <p className="st-fb-title">{outcome.result.passed ? 'You can do this' : 'Not yet'}</p>
          <ul className="st-rubric">
            {(check.rubric ?? []).map((r, i) => (
              <li key={r} className={outcome.result.met[i] ? 'met' : 'unmet'}>
                <Icon name={outcome.result.met[i] ? 'check' : 'close'} size={14} /><MixedText text={r} />
              </li>
            ))}
          </ul>
          {outcome.result.feedback && <p className="st-fb-note"><MixedText text={outcome.result.feedback} /></p>}
        </div>
      )}
      {outcome?.kind === 'no-server' && <p className="card st-note" role="status">{NEEDS_SERVER}</p>}
      {outcome?.kind === 'error' && (
        <div className="card st-error" role="alert">
          <p>The check didn't work this time. Nothing was recorded.</p>
          <button type="button" className="btn secondary" onClick={() => setOutcome(null)}>Try again</button>
        </div>
      )}
      {outcome && onDone && (
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Done</button></div>
      )}
    </div>
  );
}

export default function CanDoCheck() {
  useStudyTimer('strand');
  const { id = '' } = useParams();
  const data = useAsync(async () => {
    const units = await loadUnits();
    const unit = units.find((u) => u.canDos.some((c) => c.id === id));
    const canDo = unit?.canDos.find((c) => c.id === id);
    if (!unit || !canDo) return null;
    const grammar = new Set((await db.items.where('kind').equals('grammar').primaryKeys()).map((k) => String(k).slice('grammar:'.length)));
    return { unit, canDo, available: canDoAvailable(canDo, unit, grammar) };
  }, [id]);

  let body;
  if (data.loading) body = <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the check" />;
  else if (!data.data) {
    body = (
      <div className="card st-empty-card">
        <h2>Check not found</h2>
        <p className="muted">{data.error ? "The checks didn't load. Connect to the internet once, then try again." : "This can-do isn't on this phone."}</p>
        <Link className="btn ink" to="/learn">Back to Learn</Link>
      </div>
    );
  } else if (data.data.canDo.ready && !data.data.available) {
    body = (
      <div className="card st-empty-card">
        <h2>Not open yet</h2>
        <p className="muted">This check opens once you have learned unit {data.data.unit.id}'s grammar.</p>
      </div>
    );
  } else {
    body = <CanDoCheckView canDo={data.data.canDo} unit={data.data.unit} />;
  }
  return (
    <StudyDisplayProvider>
      <Screen label="Can-do check">
        <TopBar back="/learn" title="Can-do check" />
        {body}
      </Screen>
    </StudyDisplayProvider>
  );
}
