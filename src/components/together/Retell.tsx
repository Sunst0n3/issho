// 4/3/2 retell: each partner tells the same story (or "our week") three times, with less time
// each round (90, 60, 45 s). Turns alternate; keeping the content while the time shrinks is what
// builds fluency.

import { Countdown, secondsLeft, useTicking } from './PlanningTimer.tsx';
import type { QuizPerson } from './PartnerQuiz.tsx';
import type { LiveRun } from './session.ts';

export const RETELL_SECONDS = [90, 60, 45] as const;

/** Turn i (0–5): round floor(i / 2), the opener first in each round. */
export function retellTurn(index: number, opener: string, other: string): { round: number; seconds: number; speaker: string } {
  const round = Math.min(RETELL_SECONDS.length - 1, Math.floor(index / 2));
  return { round, seconds: RETELL_SECONDS[round], speaker: index % 2 === 0 ? opener : other };
}

export function Retell({ topic, duo, me, partner, run }: {
  /** The shared story's title, or undefined for "our week". */
  topic?: string;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  run: LiveRun;
}) {
  const { live, update, next } = run;
  const turns = RETELL_SECONDS.length * 2;
  const index = Math.min(live.index ?? 0, turns - 1);
  const other = live.opener === me.id ? partner.id : me.id;
  const { round, seconds, speaker } = retellTurn(index, live.opener, other);
  const now = useTicking(Boolean(live.timerStartedAt));
  const left = secondsLeft(live.timerStartedAt, seconds, now);
  const speakerName = speaker === me.id ? (duo ? 'You' : me.name) : partner.name;
  const last = index === turns - 1;

  const go = () => {
    if (last) next();
    else update((s) => ({ ...s, index: index + 1, timerStartedAt: undefined }));
  };

  return (
    <section className="card tg-retell" aria-live="polite">
      <p className="label">4/3/2 retell · round {round + 1} of 3 · {seconds} s</p>
      <h2>{speakerName === 'You' ? 'Your turn' : `${speakerName}'s turn`}</h2>
      <p className="muted">
        Tell {topic ? <>“{topic}”</> : 'about our week'} in Japanese. Keep the same content each round, just faster.
        {speaker !== me.id && ' Listen; ask もう一度？ if you lose the thread.'}
      </p>
      <Countdown left={left} total={seconds} label="Retell time" />
      {!live.timerStartedAt ? (
        <button type="button" className="btn primary block" onClick={() => update((s) => ({ ...s, timerStartedAt: Date.now() }))}>
          Start {seconds} s
        </button>
      ) : (
        <button type="button" className={left === 0 ? 'btn primary block' : 'btn secondary block'} onClick={go}>
          {left === 0 ? (last ? 'Done' : 'Next turn') : 'Finished early'}
        </button>
      )}
    </section>
  );
}
