// Session B (about 15 min): a task from a settled unit. Read the task card and your half of the
// information, plan in silence, run it (the AI plays the third role when it can, else the
// scripted version is read in roles), swap and run it again, answer the outcome question, then
// a private recap of your own lines. Corrections become cards only through the card guard.
// Without a task, Session B runs a free role-play (or the next core conversation) at stage 1.

import { useEffect, useId, useRef, useState } from 'react';
import type { AiRecapResponse, AiRolePlayRequest } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import type { TaskCard } from '../../lib/types.ts';
import { play, stopAudio } from '../../speech/audio.ts';
import { listen, recognitionAvailable, type Listening } from '../../speech/recognition.ts';
import { memberProgress } from '../../srs/memberProgress.ts';
import { learnerAiContext } from '../../srs/output.ts';
import { createGuardedCloze } from '../../srs/sentenceGuard.ts';
import { taskTargets } from '../../srs/together.ts';
import { aiRecap, aiRolePlay } from '../../sync/client.ts';
import { postTogetherEvent } from '../../sync/together.ts';
import { Icon, Ruby } from '../ui.tsx';
import { aiErrorMessage } from './ai.ts';
import { ConversationStage } from './ConversationStage.tsx';
import { PlanningTimer } from './PlanningTimer.tsx';
import type { Role } from './rolePlay.ts';
import { MissingContent, SkipStep, type SessionProps } from './SessionA.tsx';
import { TaskCardView } from './TaskCardView.tsx';

type Turn = AiRolePlayRequest['history'][number];

/** The task-card targets for this phone: the authored ones either partner met 2–21 days ago, topped up from both. */
export function useTaskTargets(task: TaskCard | undefined, partnerRecent: readonly string[]) {
  const [state, setState] = useState<{ targets: string[]; mine: Set<string> }>();
  useEffect(() => {
    if (!task) return;
    let alive = true;
    memberProgress()
      .catch(() => undefined)
      .then((p) => {
        if (!alive) return;
        const mine = p?.recentItems ?? [];
        setState({ targets: taskTargets(task.targets, mine, partnerRecent), mine: new Set(mine) });
      });
    return () => { alive = false; };
  }, [task?.id, partnerRecent.join('|')]);
  return state;
}

export function SessionB(props: SessionProps) {
  const { run, plan, duo, me, partner, partnerProgress, roleplays, units } = props;
  const unit = plan.task ? units.find((u) => u.id === plan.task!.unit) : undefined;
  const task = unit && unit.task.id === plan.task?.taskId ? unit.task : undefined;
  const targets = useTaskTargets(task, partnerProgress?.recentItems ?? []);
  /** This member's own lines across both runs, for the private recap. */
  const myLines = useRef<string[]>([]);
  const step = run.live.step;

  if (step === 'roleplay') {
    const script = roleplays.find((s) => s.id === plan.rolePlayId);
    if (!script) return <SkipStep run={run} what="This role-play" />;
    return <ConversationStage script={script} stage={1} duo={duo} me={me} partner={partner} run={run} markStage={false} />;
  }
  if (!task || !plan.task) return <SkipStep run={run} what="This task" />;

  // Roles: the opener is A on the first run, B after the swap.
  const openerRole: Role = step === 'swap' ? 'b' : 'a';
  const myRole: Role | 'both' = !duo ? 'both' : run.live.opener === me.id ? openerRole : openerRole === 'a' ? 'b' : 'a';

  switch (step) {
    case 'task':
      return (
        <>
          <TaskCardView task={task} unit={unit} targets={targets?.targets ?? []} mine={targets?.mine ?? new Set()}
            half={myRole === 'both' ? 'both' : myRole} partnerName={partner.name} repeat={plan.task.repeat} />
          <button type="button" className="btn primary block" onClick={run.next}>Plan in silence</button>
        </>
      );
    case 'plan':
      return (
        <PlanningTimer startedAt={run.live.timerStartedAt}
          onStart={(at) => run.update((s) => ({ ...s, timerStartedAt: at }))} onDone={run.next} />
      );
    case 'run':
    case 'swap':
      return (
        <TaskRun key={step} task={task} props={props} myRole={myRole} swapped={step === 'swap'}
          onMyLine={(text) => myLines.current.push(text)} />
      );
    case 'outcome':
      return (
        <section className="card tg-outcome">
          <p className="label">Outcome</p>
          <h2>{task.outcomeQuestion}</h2>
          <p className="muted">Answer it together, in Japanese if you can.</p>
          <button type="button" className="btn primary block" onClick={run.next}>We answered it</button>
        </section>
      );
    case 'recap':
      return <Recap task={task} props={props} lines={myLines.current} repeat={plan.task.repeat} />;
    default:
      return null;
  }
}

/**
 * One run of the task. With the AI on (and an AI role in the task), the AI plays that role:
 * its lines are spoken with the second voice and the learners answer by voice (speech
 * recognition) or by typing, on the opener's phone in duo. Otherwise the scripted version is
 * read in roles.
 */
function TaskRun({ task, props, myRole, swapped, onMyLine }: {
  task: TaskCard;
  props: SessionProps;
  myRole: Role | 'both';
  swapped: boolean;
  onMyLine(text: string): void;
}) {
  const { run, duo, me, partner, aiOn, online } = props;
  const useAi = Boolean(aiOn && online && task.aiRole);
  if (useAi && duo && run.live.opener !== me.id) {
    return <SideRun partnerName={partner.name} aiRole={task.aiRole!} onMyLine={onMyLine} onNext={run.next} swapped={swapped} />;
  }
  return useAi
    ? <AiRun task={task} props={props} myRole={myRole} swapped={swapped} onMyLine={onMyLine} />
    : <ScriptedRun task={task} props={props} myRole={myRole} swapped={swapped} />;
}

function AiRun({ task, props, myRole, swapped, onMyLine }: {
  task: TaskCard;
  props: SessionProps;
  myRole: Role | 'both';
  swapped: boolean;
  onMyLine(text: string): void;
}) {
  const id = useId();
  const { run, me, partner, duo } = props;
  const [history, setHistory] = useState<Turn[]>([]);
  const [en, setEn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string>();
  const [speaker, setSpeaker] = useState<Role>(myRole === 'both' ? 'a' : myRole);
  const started = useRef(false);
  const ctx = useRef<Awaited<ReturnType<typeof learnerAiContext>>>();
  const nameOf = (role: Role) => {
    // The opener is A on the first run and B on the swap.
    const openerIsMe = run.live.opener === me.id;
    const openerRole: Role = swapped ? 'b' : 'a';
    const mine = duo ? (openerIsMe ? role === openerRole : role !== openerRole) : role === openerRole;
    return mine ? me.name : partner.name;
  };

  const ask = async (turns: Turn[]) => {
    setBusy(true);
    setError(undefined);
    try {
      ctx.current ??= await learnerAiContext().catch(() => ({}));
      const reply = await aiRolePlay({ ...ctx.current, taskId: task.id, aiRole: task.aiRole!, goal: task.goal, history: turns.slice(-30) });
      setHistory([...turns, { speaker: 'ai', text: reply.reply }]);
      setEn((list) => [...list, reply.en]);
      if (reply.done) setDone(true);
      void play({ text: reply.reply, voice: 'm' });
    } catch (e) {
      setError(aiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ask([]);
  }, []);

  const say = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const turns = [...history, { speaker, text }];
    setHistory(turns);
    if (nameOf(speaker) === me.name) onMyLine(text);
    if (myRole === 'both') setSpeaker(speaker === 'a' ? 'b' : 'a');
    void ask(turns);
  };

  let aiIndex = 0;
  return (
    <section className="card tg-task-run" aria-labelledby={`${id}-title`}>
      <p className="label">{swapped ? 'Roles swapped' : 'Run the task'} · the AI is the {task.aiRole}</p>
      <h2 id={`${id}-title`} className="visually-hidden">Conversation with the AI</h2>
      <ol className="tg-task-log" aria-live="polite">
        {history.map((turn, i) => (
          <li key={i} className={turn.speaker === 'ai' ? 'tg-ai' : 'tg-learner'}>
            <span className="label">{turn.speaker === 'ai' ? task.aiRole : nameOf(turn.speaker)}</span>
            <span lang="ja"><Ruby text={turn.text} show="all" /></span>
            {turn.speaker === 'ai' && <AiLineTools text={turn.text} en={en[aiIndex++]} />}
          </li>
        ))}
      </ol>
      {busy && <p className="muted" role="status"><span className="tg-pulse" aria-hidden="true" /> The {task.aiRole} is thinking…</p>}
      {error && (
        <p className="tg-composer-notice" role="alert">
          {error} <button type="button" className="tg-link-btn" onClick={() => void ask(history)}>Try again</button>
        </p>
      )}
      {!done && (
        <form className="tg-composer-row" onSubmit={(e) => { e.preventDefault(); say(); }}>
          {/* Both partners talk to the AI on this phone: say whose line it is. */}
          <button type="button" className="btn ghost small" onClick={() => setSpeaker(speaker === 'a' ? 'b' : 'a')}
            aria-label={`Speaking: ${nameOf(speaker)}. Tap to switch`}>
            {nameOf(speaker)}
          </button>
          <input className="tg-composer-input" lang="ja" value={draft} maxLength={300} placeholder="What you said, in Japanese"
            aria-label="What you said" onChange={(e) => setDraft(e.target.value)} />
          <VoiceLine disabled={busy} onHeard={(heard) => setDraft(heard.slice(0, 300))} onNotice={setNotice} />
          <button type="submit" className="tg-send-btn" aria-label="Say it" disabled={!draft.trim() || busy}>
            <Icon name="send" size={22} />
          </button>
        </form>
      )}
      {notice && <p className="tg-say-note" role="status">{notice}</p>}
      {done && <p role="status">The scene is over.</p>}
      <button type="button" className={done ? 'btn primary block' : 'btn secondary block'} onClick={run.next}>
        {swapped ? 'Done' : 'Swap roles'}
      </button>
    </section>
  );
}

/**
 * Answer the AI by voice: speech recognition fills in the line, which the learner can still
 * correct before it goes. Hidden where the browser has no speech recognition (typing always works).
 */
export function VoiceLine({ disabled, onHeard, onNotice }: {
  disabled?: boolean;
  onHeard(text: string): void;
  onNotice(text: string | undefined): void;
}) {
  const [listening, setListening] = useState(false);
  const current = useRef<Listening | null>(null);
  useEffect(() => () => {
    current.current?.stop();
    current.current = null;
  }, []);
  if (!recognitionAvailable()) return null;

  const toggle = () => {
    if (current.current) {
      current.current.stop();
      return;
    }
    // The AI's voice from this phone would be heard as the learner's line.
    stopAudio();
    onNotice(undefined);
    const run = listen({ lang: 'ja-JP', timeoutMs: 15_000 });
    current.current = run;
    setListening(true);
    const settle = () => {
      if (current.current !== run) return false;
      current.current = null;
      setListening(false);
      return true;
    };
    run.result.then(
      (heard) => {
        if (!settle()) return;
        if (heard.trim()) onHeard(heard.trim());
        else onNotice("We didn't catch that. Try again, or type it.");
      },
      () => { if (settle()) onNotice("Speech recognition didn't work here. Type the line instead."); },
    );
  };

  return (
    <button type="button" className={listening ? 'btn primary small' : 'btn ghost small'} aria-pressed={listening}
      aria-label={listening ? 'Listening, tap to stop' : 'Say your line'} disabled={disabled && !listening} onClick={toggle}>
      <Icon name={listening ? 'stop' : 'mic'} size={18} />
    </button>
  );
}

function AiLineTools({ text, en }: { text: string; en?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="tg-ai-tools">
      <button type="button" className="tg-link-btn" onClick={() => void play({ text, voice: 'm' })}>Again</button>
      {en && (shown ? <span className="muted"> {en}</span> : (
        <button type="button" className="tg-link-btn" onClick={() => setShown(true)}>English</button>
      ))}
    </span>
  );
}

/** Duo, the joiner's phone: the AI talks on the opener's phone; note your own lines for the recap. */
function SideRun({ partnerName, aiRole, onMyLine, onNext, swapped }: {
  partnerName: string;
  aiRole: string;
  onMyLine(text: string): void;
  onNext(): void;
  swapped: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string>();
  const [noted, setNoted] = useState<string[]>([]);
  const note = () => {
    const text = draft.trim();
    if (!text) return;
    onMyLine(text);
    setNoted((n) => [...n, text]);
    setDraft('');
  };
  return (
    <section className="card tg-task-run">
      <p className="label">{swapped ? 'Roles swapped' : 'Run the task'}</p>
      <h2>The {aiRole} talks on {partnerName}'s phone</h2>
      <p className="muted">Speak to it there. To get your own private recap, add what you said here too.</p>
      <ul className="tg-task-log">{noted.map((t, i) => <li key={i} lang="ja">{t}</li>)}</ul>
      <form className="tg-composer-row" onSubmit={(e) => { e.preventDefault(); note(); }}>
        <input className="tg-composer-input" lang="ja" value={draft} maxLength={300} placeholder="What you said"
          aria-label="What you said" onChange={(e) => setDraft(e.target.value)} />
        <VoiceLine onHeard={(heard) => setDraft(heard.slice(0, 300))} onNotice={setNotice} />
        <button type="submit" className="btn secondary small" disabled={!draft.trim()}>Add</button>
      </form>
      {notice && <p className="tg-say-note" role="status">{notice}</p>}
      <button type="button" className="btn secondary block" onClick={onNext}>{swapped ? 'Done' : 'Swap roles'}</button>
    </section>
  );
}

/** Without the AI: the scripted version, read in roles. */
function ScriptedRun({ task, props, myRole, swapped }: {
  task: TaskCard;
  props: SessionProps;
  myRole: Role | 'both';
  swapped: boolean;
}) {
  const { run, me, partner } = props;
  const lines = task.scripted;
  const index = Math.min(run.live.index ?? 0, lines.length);
  if (!lines.length) return <MissingContent what="The scripted version" />;
  if (index >= lines.length) {
    return (
      <section className="card tg-task-run">
        <h2>{swapped ? 'Both runs done' : 'Now swap roles'}</h2>
        <button type="button" className="btn primary block" onClick={run.next}>{swapped ? 'Done' : 'Swap roles'}</button>
      </section>
    );
  }
  const line = lines[index];
  const mine = myRole === 'both' || line.role === myRole;
  const speaker = myRole === 'both'
    ? (line.role === (swapped ? 'b' : 'a') ? me.name : partner.name)
    : mine ? 'You' : partner.name;
  return (
    <section className="card tg-task-run" aria-live="polite">
      <p className="label">Scripted version · line {index + 1} of {lines.length} · {task.roles[line.role]}</p>
      <p className="label">{speaker}</p>
      <p className="tg-rp-jp" lang="ja"><Ruby text={line.jp} show="all" /></p>
      {mine && <p className="tg-rp-en">{line.en}</p>}
      <button type="button" className="btn primary block" onClick={() => run.update((s) => ({ ...s, index: index + 1 }))}>
        Next
      </button>
    </section>
  );
}

/**
 * The private recap: 1–2 points from this member's own lines (quote → corrected + rule). A point
 * becomes a cloze card only when the card guard accepts it. Offline there is no recap.
 */
function Recap({ task, props, lines, repeat }: { task: TaskCard; props: SessionProps; lines: readonly string[]; repeat: boolean }) {
  const { run, aiOn, online } = props;
  const [state, setState] = useState<{ recap?: AiRecapResponse; cards: number; error?: string; loading: boolean }>(
    { cards: 0, loading: Boolean(aiOn && online && lines.length) },
  );
  const started = useRef(false);
  const posted = useRef(false);

  useEffect(() => {
    if (started.current || !aiOn || !online || !lines.length) return;
    started.current = true;
    void (async () => {
      try {
        const recap = await aiRecap({ ...(await learnerAiContext().catch(() => ({}))), goal: task.goal, lines: lines.slice(-30) });
        let cards = 0;
        for (const p of recap.points.slice(0, 2)) {
          const card = await createGuardedCloze({ corrected: p.corrected, en: '', words: p.words, grammarUsed: p.grammarUsed }, 'recap')
            .catch(() => null);
          if (card) cards++;
        }
        setState({ recap, cards, loading: false });
      } catch (e) {
        setState({ cards: 0, loading: false, error: aiErrorMessage(e) });
      }
    })();
  }, []);

  const finish = () => {
    if (!posted.current) {
      posted.current = true;
      void postTogetherEvent({ type: 'task-done', taskId: task.id, date: dayKey(), repeat });
    }
    run.next();
  };

  return (
    <section className="card tg-recap" aria-live="polite">
      <p className="label">Your private recap</p>
      <p className="tg-tip-private">Only you can see this.</p>
      {!aiOn || !online ? (
        <p className="muted">The recap needs the home server's AI. Nothing to see this time.</p>
      ) : !lines.length ? (
        <p className="muted">No lines of yours were typed this time, so there is nothing to recap.</p>
      ) : state.loading ? (
        <p className="muted"><span className="tg-pulse" aria-hidden="true" /> Looking over your lines…</p>
      ) : state.error ? (
        <p className="tg-composer-notice">{state.error}</p>
      ) : state.recap && (
        <>
          {state.recap.praise && <p>{state.recap.praise}</p>}
          {state.recap.points.length === 0 ? <p className="muted">Nothing to fix. Nicely done.</p> : (
            <ul className="tg-recap-points">
              {state.recap.points.slice(0, 2).map((p, i) => (
                <li key={i}>
                  <p lang="ja"><span className="tg-diff-del">{p.quote}</span> → <span className="tg-diff-ins">{p.corrected}</span></p>
                  <p className="tg-tip-why">{p.rule}</p>
                </li>
              ))}
            </ul>
          )}
          {state.cards > 0 && <p className="muted tg-small">{state.cards === 1 ? 'One sentence' : `${state.cards} sentences`} added to your reviews.</p>}
        </>
      )}
      <button type="button" className="btn primary block" onClick={finish}>Finish the task</button>
    </section>
  );
}
