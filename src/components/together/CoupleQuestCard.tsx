// The weekly couple quest: every partner 5 minimum days, plus sessions A, B and C (the monthly
// session can stand in for one), with one reserve a month that covers a single shortfall.

import type { CoupleQuest, TogetherSessionId } from '../../../shared/api.ts';
import { Icon } from '../ui.tsx';

const LETTERS = ['A', 'B', 'C'] as const;
const DAYS = 5;

/** "A and B done, C left", "A, B and C done", "none yet". */
export function lettersLine(done: ReadonlySet<TogetherSessionId>, count: number): string {
  const doneLetters = LETTERS.filter((l) => done.has(l));
  const left = LETTERS.filter((l) => !done.has(l));
  const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  if (count >= 3) return doneLetters.length === 3 ? 'sessions A, B and C done' : 'three sessions done';
  if (!doneLetters.length) return count > 0 ? 'the monthly session done' : 'no sessions yet';
  // The monthly session stood in for one letter: one fewer is left than the letters say.
  if (count > doneLetters.length) return `sessions ${list(doneLetters)} and the monthly done, ${left.join(' or ')} left`;
  return `sessions ${list(doneLetters)} done, ${list(left)} left`;
}

export function CoupleQuestCard({ quest, members, done, streakWeeks }: {
  quest: CoupleQuest;
  /** [memberId, display name], this phone's member first. */
  members: readonly (readonly [string, string])[];
  /** Session ids done this week (from the together state); counts alone when unknown. */
  done: ReadonlySet<TogetherSessionId>;
  streakWeeks: number;
}) {
  const reserve = quest.reserveUsed
    ? 'met with the month’s reserve'
    : quest.reserveLeft ? 'reserve available' : 'this month’s reserve is used';
  return (
    <section className={quest.met ? 'card tg-quest tg-met' : 'card tg-quest'} aria-labelledby="tg-quest-title">
      <div className="tg-week-head">
        <h2 id="tg-quest-title"><Icon name="quest" size={18} /> Couple quest</h2>
        {quest.met && <span className="chip shu">Met</span>}
      </div>
      <p className="tg-quest-line">
        {members.map(([id, name], i) => (
          <span key={id}>
            {i > 0 && ' · '}
            {name} {Math.min(DAYS, quest.minimumDays[id] ?? 0)} of {DAYS} days
          </span>
        ))}
      </p>
      <p className="tg-quest-line">{lettersLine(done, quest.togetherSessions)} · {reserve}</p>
      {!quest.met && quest.daysLeft > 0 && (
        <p className="muted tg-small">{quest.daysLeft === 1 ? 'Last day this week.' : `${quest.daysLeft} days left this week.`}</p>
      )}
      {streakWeeks > 0 && (
        <p className="tg-quest-streak">
          Quest met {streakWeeks} {streakWeeks === 1 ? 'week' : 'weeks'} running
        </p>
      )}
    </section>
  );
}
