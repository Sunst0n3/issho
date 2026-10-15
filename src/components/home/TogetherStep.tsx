// Onboarding: the three weekly together slots, a shared goal with a date, and the ground rules.
import type { TogetherSlot } from '../../lib/types.ts';
import { GoalFields, PartnerRules, SlotsEditor, type GoalDraft } from './planControls.tsx';

export function TogetherStep({ slots, goal, today, fromPartner, onSlots, onGoal }: {
  slots: TogetherSlot[];
  goal: GoalDraft;
  /** 'YYYY-MM-DD': the earliest goal date. */
  today: string;
  /** The slots came from the household (the partner set them already). */
  fromPartner: boolean;
  onSlots: (slots: TogetherSlot[]) => void;
  onGoal: (goal: GoalDraft) => void;
}) {
  return (
    <div className="hm-together">
      <section className="hm-together-slots" aria-labelledby="together-slots-title">
        <h2 id="together-slots-title" className="hm-section-title">Three sessions a week, 15 minutes each</h2>
        {fromPartner && <p className="hm-hint">Your partner picked these. Change them here if they don't suit you both.</p>}
        <SlotsEditor slots={slots} onChange={onSlots} />
      </section>
      <div className="card">
        <GoalFields draft={goal} onChange={onGoal} min={today} />
      </div>
      <PartnerRules />
    </div>
  );
}
