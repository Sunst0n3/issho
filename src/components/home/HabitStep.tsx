// Onboarding: the if-then plan ("After I ___ at ___, I open Issho" + a reminder time) and the
// coping plan for busy days.
import { CopingField, CueFields, type CueDraft, type CueProblem } from './planControls.tsx';

export function HabitStep({ cue, coping, cueProblem, onCue, onCoping }: {
  cue: CueDraft;
  coping: string;
  /** Continue found the cue half filled: shown with the field to fix. */
  cueProblem?: CueProblem;
  onCue: (d: CueDraft) => void;
  onCoping: (v: string) => void;
}) {
  return (
    <div className="hm-habit">
      <div className="card hm-habit-card">
        <CueFields draft={cue} onChange={onCue} problem={cueProblem} />
      </div>
      <div className="card hm-habit-card">
        <CopingField value={coping} onChange={onCoping} />
      </div>
      <p className="hm-hint">
        Tie Issho to something you already do every day. Plans like this make a habit much more likely to stick.
      </p>
    </div>
  );
}
