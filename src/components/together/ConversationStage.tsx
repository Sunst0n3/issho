// A core conversation at one stage, inside a together session (a RolePlayRun variant):
// S1 listen to the model audio and shadow, S2 perform from the Japanese (English behind a
// tap), S3 swap roles, S4 keyword cue cards. At the end each partner marks the run smooth or
// "again next time"; the server moves the stage on once both marked it smooth.
//
// Session B's free run (markStage false) stays at stage 1: listen and shadow, then read it in
// roles with the English shown, as often as there is time (roles swap on each later read).

import { useEffect, useId, useReducer, useState } from 'react';
import type { RolePlay } from '../../lib/types.ts';
import { play } from '../../speech/audio.ts';
import { postTogetherEvent, useTogetherState } from '../../sync/together.ts';
import { Icon, ProgressBar, Ruby } from '../ui.tsx';
import type { QuizPerson } from './PartnerQuiz.tsx';
import {
  cueOf,
  cueOnly,
  englishHidden,
  initialStage,
  lineClip,
  STAGE_NAMES,
  stageReducer,
  swapRoles,
  type Role,
  type Stage,
} from './rolePlay.ts';
import type { LiveRun } from './session.ts';

/** Which role a member speaks: the opener is A, or B when roles are swapped (S3). */
export function roleOf(memberId: string, opener: string, swapped: boolean): Role {
  const openerRole: Role = swapped ? 'b' : 'a';
  return memberId === opener ? openerRole : openerRole === 'a' ? 'b' : 'a';
}

/**
 * Where a run stands. Both phones only ever move forward, so the live index keeps counting
 * across runs: each run is `total` lines plus its end card. Session A has a single run.
 */
export function runPosition(rawIndex: number, total: number, singleRun: boolean): { run: number; line: number } {
  if (singleRun) return { run: 0, line: Math.min(rawIndex, total) };
  return { run: Math.floor(rawIndex / (total + 1)), line: rawIndex % (total + 1) };
}

export function ConversationStage({ script, stage, duo, me, partner, run, markStage }: {
  script: RolePlay;
  stage: Stage;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  run: LiveRun;
  /** Session A marks the stage; Session B's free run never does. */
  markStage: boolean;
}) {
  const id = useId();
  const { live, update, next } = run;
  const total = script.lines.length;
  const raw = live.index ?? 0;
  const { run: runNo, line: index } = runPosition(raw, total, markStage);
  // The free run: the first time through is listen and shadow, every later one is read in roles.
  const reading = !markStage && runNo >= 1;
  const swapped = markStage ? swapRoles(stage) : runNo >= 2 && runNo % 2 === 0;
  const myRole = roleOf(me.id, live.opener, swapped);
  const nameOf = (role: Role) => (role === myRole ? (duo ? 'You' : me.name) : partner.name);
  // Absolute targets: a double tap, or both phones tapping, moves on once.
  const goTo = (target: number) => update((s) => ((s.index ?? 0) === target - 1 ? { ...s, index: target } : s));

  if (index >= total) {
    if (markStage) return <StageMarks script={script} stage={stage} duo={duo} me={me} partner={partner} onDone={next} />;
    return (
      <section className="card" aria-labelledby={`${id}-end`}>
        <h2 id={`${id}-end`}>{reading ? 'Nicely done' : 'Now read it in roles'}</h2>
        <p className="muted">
          {reading
            ? 'Read it once more with roles swapped if there’s time.'
            : 'Each of you takes a part and reads it out, with the English shown.'}
        </p>
        <div className="tg-button-row">
          <button type="button" className={reading ? 'btn secondary small' : 'btn primary small'} onClick={() => goTo(raw + 1)}>
            {reading ? 'Again, roles swapped' : 'Read it in roles'}
          </button>
        </div>
        <button type="button" className={reading ? 'btn primary block' : 'btn secondary block'} onClick={next}>Continue</button>
      </section>
    );
  }

  const line = script.lines[index];
  const mine = !duo || line.role === myRole;
  const title = reading ? `Read in roles${swapped ? ', swapped' : ''}` : `S${stage} ${STAGE_NAMES[stage]}`;
  return (
    <section className="tg-stage" aria-labelledby={`${id}-title`}>
      <ProgressBar value={index / total} label="Conversation progress" />
      <p className="label" id={`${id}-title`}>
        {script.title} · {title} · line {index + 1} of {total}
      </p>
      <StageLine key={`${raw}:${stage}`} scriptId={script.id} index={index} line={line} stage={reading ? 2 : stage}
        showEnglish={reading} speaker={nameOf(line.role)} mine={mine} duo={duo} roleName={script.roles[line.role].name} />
      <button type="button" className="btn primary block" onClick={() => goTo(raw + 1)}>
        {index + 1 === total ? 'Finish' : 'Next'}
      </button>
    </section>
  );
}

function StageLine({ scriptId, index, line, stage, showEnglish = false, speaker, mine, duo, roleName }: {
  scriptId: string;
  index: number;
  line: RolePlay['lines'][number];
  stage: Stage;
  /** Read in roles with the English shown (the free run after listen and shadow). */
  showEnglish?: boolean;
  speaker: string;
  mine: boolean;
  duo: boolean;
  roleName: string;
}) {
  const [showEn, setShowEn] = useState(false);
  const [showJp, setShowJp] = useState(false);
  const clip = lineClip(scriptId, index, line);
  const listen = () => void play({ ref: clip.ref }, { voice: clip.voice, fallbackText: clip.text });

  if (stage === 1) {
    return (
      <article className="card tg-stage-line">
        <p className="label">{roleName} · {speaker}</p>
        <p className="tg-rp-jp" lang="ja"><Ruby text={line.jp} show="all" /></p>
        <p className="tg-rp-en">{line.en}</p>
        <button type="button" className="btn secondary small" onClick={listen}><Icon name="speaker" size={16} />Play</button>
        <p className="muted tg-small">Listen, then both say it right after the audio.</p>
      </article>
    );
  }

  if (!mine) {
    return (
      <article className="card tg-stage-line tg-theirs">
        <p className="label">{roleName} · {speaker}</p>
        <h2 className="tg-rp-listen">Listen to {speaker}</h2>
        {cueOnly(stage) ? null : <p className="tg-rp-jp" lang="ja"><Ruby text={line.jp} show="all" /></p>}
        {showEnglish && <p className="tg-rp-en">{line.en}</p>}
      </article>
    );
  }

  const hideJp = cueOnly(stage) && !showJp;
  return (
    <article className="card tg-stage-line tg-mine">
      <p className="label">{roleName} · {duo ? 'your line' : speaker}</p>
      {hideJp
        ? <p className="tg-stage-cue">{cueOf(line)}</p>
        : <p className="tg-rp-jp" lang="ja"><Ruby text={line.jp} show="all" /></p>}
      {englishHidden(stage) && !showEnglish && !showEn
        ? null
        : !cueOnly(stage) && <p className="tg-rp-en">{line.en}</p>}
      <div className="tg-rp-tools">
        {englishHidden(stage) && !showEnglish && !cueOnly(stage) && !showEn && (
          <button type="button" className="btn ghost small" onClick={() => setShowEn(true)}>Show English</button>
        )}
        {hideJp && <button type="button" className="btn ghost small" onClick={() => setShowJp(true)}>Show the line</button>}
        <button type="button" className="btn ghost small" onClick={listen}><Icon name="speaker" size={16} />Hear it</button>
      </div>
    </article>
  );
}

/** How did it go? Smooth from both partners moves the conversation to its next stage. */
function StageMarks({ script, stage, duo, me, partner, onDone }: {
  script: RolePlay;
  stage: Stage;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  onDone(): void;
}) {
  const [state, dispatch] = useReducer(stageReducer, undefined, () => initialStage(script.id, stage));
  const [marked, setMarked] = useState<'smooth' | 'again'>();
  const members = duo ? [me.id, partner.id] : [me.id];
  // The partner's mark reaches this phone through the household's together state.
  const { state: together } = useTogetherState();
  const serverStage = together?.stages[script.id];
  const serverSmooth = together?.smooth[script.id]?.join(',') ?? '';
  useEffect(() => {
    // A run held at S1 (its unit isn't settled yet) can't move a script the server has further on.
    if (!together || (serverStage ?? 1) > stage + 1) return;
    dispatch({ type: 'sync', stage: serverStage ?? 1, smooth: serverSmooth ? serverSmooth.split(',') : [] });
  }, [serverStage, serverSmooth]);

  const smooth = () => {
    if (marked) return;
    setMarked('smooth');
    dispatch({ type: 'smooth', memberId: me.id, members });
    // Pass-and-play: one tap says it for both partners on this phone.
    void postTogetherEvent(duo ? { type: 'smooth', scriptId: script.id, stage } : { type: 'smooth', scriptId: script.id, stage, both: true });
  };

  return (
    <section className="card tg-stage-marks" aria-live="polite">
      <h2>How did S{stage} go?</h2>
      <p className="muted">
        {duo ? `You and ${partner.name} each mark it.` : 'Decide together.'} Smooth from both of you moves this conversation on to
        {stage === 4 ? ' done.' : ` S${stage + 1}: ${STAGE_NAMES[(stage + 1) as Stage]}.`}
      </p>
      {!marked ? (
        <div className="tg-button-row">
          <button type="button" className="btn primary small" onClick={smooth}>{duo ? 'Smooth' : 'Smooth for both of us'}</button>
          <button type="button" className="btn ghost small" onClick={() => { setMarked('again'); dispatch({ type: 'again' }); }}>
            Again next time
          </button>
        </div>
      ) : (
        <p role="status">
          {marked === 'again'
            ? `Same stage next time: S${stage}.`
            : state.finished
              ? 'Conversation done. A new one starts next time.'
              : state.stage > stage
                ? `Next time: S${state.stage}.`
                : `Marked. It moves on when ${partner.name} marks it too.`}
        </p>
      )}
      <button type="button" className="btn primary block" disabled={!marked} onClick={onDone}>Continue</button>
    </section>
  );
}
