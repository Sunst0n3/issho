// Today's prompts, at most one at a time: rest token → welcome-back → travel → plan review → make-up.
// Plus the fresh-start header and the quiet line about the make-up before today's goal is met.
// A streak offer (token, make-up) shows only while it can still keep the streak, and the welcome-back
// warm-up only until today counts.
import { Link } from 'react-router-dom';
import { updateSettings } from '../../lib/db.ts';
import type { Settings } from '../../lib/types.ts';
import type { ComebackOffer, StreakV2 } from '../../srs/habits.ts';
import { Icon } from '../ui.tsx';
import { ComebackCard } from './ComebackCard.tsx';
import { dayLabel, deadlineText, weekdayOf } from './labels.ts';
import { RestTokenPrompt } from './RestTokenPrompt.tsx';
import { TravelBanner } from './TravelBanner.tsx';

export type TodayPromptKind = 'rest-token' | 'comeback' | 'travel' | 'plan-review' | 'makeup';

export interface PromptInputs {
  today: string;
  streak: StreakV2;
  comeback: ComebackOffer;
  settings: Pick<Settings, 'travelUntil' | 'planReviewDays'>;
  /** Prompts put away earlier today. */
  dismissed: ReadonlySet<TodayPromptKind>;
}

/** The plan-review days that have come (course weeks 4 and 8), oldest first. */
export function duePlanReviews(days: readonly string[], today: string): string[] {
  return days.filter((d) => d <= today).sort();
}

/**
 * pure: a rest token for yesterday keeps the streak only when yesterday is the one uncovered day of the gap.
 * After a longer gap the run is already over, and a token spent on yesterday would be wasted.
 */
export function tokenKeepsStreak(p: Pick<PromptInputs, 'comeback'>): boolean {
  return p.comeback.missedDays <= 1;
}

/**
 * pure: a make-up repairs a missed day only within 48 hours of it, so after a gap long enough for a fresh start
 * (3 days or more) the oldest missed day is past repair and the streak can't be kept.
 */
export function makeupKeepsStreak(p: Pick<PromptInputs, 'comeback'>): boolean {
  return p.comeback.kind !== 'fresh-start';
}

/**
 * pure: the welcome-back card while it still offers something. Its warm-up is a way back into a minimum day,
 * so it goes once today counts; after a longer gap the card stays for the fresh start alone.
 */
export function comebackOpen(p: Pick<PromptInputs, 'comeback' | 'streak'>): boolean {
  if (p.comeback.kind === 'none') return false;
  return !p.streak.todayMinimum || p.comeback.kind === 'fresh-start';
}

/** pure: the one prompt Today shows, in the fixed order, or null. */
export function choosePrompt(p: PromptInputs): TodayPromptKind | null {
  const open = (kind: TodayPromptKind) => !p.dismissed.has(kind);
  if (p.streak.offerTokenFor && tokenKeepsStreak(p) && open('rest-token')) return 'rest-token';
  if (comebackOpen(p) && open('comeback')) return 'comeback';
  if (p.settings.travelUntil && p.settings.travelUntil >= p.today) return 'travel';
  if (duePlanReviews(p.settings.planReviewDays, p.today).length > 0) return 'plan-review';
  if (p.streak.makeupOffer && p.streak.repairable && makeupKeepsStreak(p)) return 'makeup';
  return null;
}

function PlanReviewPrompt({ days, today }: { days: readonly string[]; today: string }) {
  // Either way the prompt is done for those days: the review days are taken off the list.
  const finish = () => void updateSettings({ planReviewDays: days.filter((d) => d > today) });
  return (
    <section className="card hm-prompt" aria-labelledby="plan-review-title">
      <h2 id="plan-review-title" className="hm-prompt-title"><Icon name="calendar" size={18} />Time to look at your plan</h2>
      <p className="hm-hint">
        A few weeks in: does your daily time, your cue and your together slots still fit? Talk it over together.
      </p>
      <div className="hm-prompt-actions">
        <Link to="/settings#set-habits" className="btn secondary small" onClick={finish}>Review my plan</Link>
        <button type="button" className="btn ghost small" onClick={finish}>It still fits</button>
      </div>
    </section>
  );
}

function MakeupOffer({ repairable }: { repairable: NonNullable<StreakV2['repairable']> }) {
  return (
    <section className="card hm-prompt" aria-labelledby="makeup-title">
      <h2 id="makeup-title" className="hm-prompt-title">
        <Icon name="repair" size={18} />
        Make up {weekdayOf(repairable.date)}: 10 more minutes before {deadlineText(repairable.deadline)} keeps your streak
      </h2>
      <div className="hm-prompt-actions">
        <Link to="/session?mode=makeup" className="btn secondary small">
          Start the make-up <Icon name="arrow" size={18} />
        </Link>
      </div>
    </section>
  );
}

/** Before today's goal is met: a make-up is possible, but only after today's own session. */
export function MakeupLater({ streak, comeback }: { streak: StreakV2; comeback?: ComebackOffer }) {
  if (!streak.repairable || streak.makeupOffer || streak.todayGoal) return null;
  if (comeback && !makeupKeepsStreak({ comeback })) return null;
  return (
    <p className="hm-quiet">
      A 10-minute make-up for {weekdayOf(streak.repairable.date)} opens after today's session.
    </p>
  );
}

export function FreshStartHeader({ freshStart, today }: { freshStart?: string; today: string }) {
  if (!freshStart || freshStart > today) return null;
  return (
    <section className="hm-fresh-head" aria-label="Fresh start">
      <p className="hm-fresh-title">
        {freshStart === today ? 'A fresh start — this week begins today' : `A fresh start — this week began ${dayLabel(freshStart)}`}
      </p>
      <p className="hm-hint">Reviews settle first, then new items come back.</p>
    </section>
  );
}

export function TodayPrompt({ kind, inputs, freshStart, onDismiss }: {
  kind: TodayPromptKind | null;
  inputs: PromptInputs;
  freshStart?: string;
  onDismiss: (kind: TodayPromptKind) => void;
}) {
  const { streak, comeback, settings, today } = inputs;
  switch (kind) {
    case 'rest-token':
      return (
        <RestTokenPrompt date={streak.offerTokenFor!} today={today} tokensLeftThisWeek={streak.tokensLeftThisWeek}
          onDismiss={() => onDismiss('rest-token')} />
      );
    case 'comeback':
      return (
        <ComebackCard offer={comeback} chosenFreshStart={freshStart} warmUp={!streak.todayMinimum}
          onDismiss={() => onDismiss('comeback')} />
      );
    case 'travel':
      return <TravelBanner until={settings.travelUntil!} />;
    case 'plan-review':
      return <PlanReviewPrompt days={settings.planReviewDays} today={today} />;
    case 'makeup':
      return <MakeupOffer repairable={streak.repairable!} />;
    default:
      return null;
  }
}
