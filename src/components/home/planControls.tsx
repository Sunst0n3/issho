// The learner's plan, as edited in onboarding and in Settings: the daily minutes, the if-then cue,
// the coping plan, the together slots and the shared goal.
import { useId } from 'react';
import { DAILY_MINUTES } from '../../lib/db.ts';
import type { DailyMinutes, HabitCue, SharedGoal, TogetherSlot } from '../../lib/types.ts';
import { DEFAULT_MINUTES, isoWeekdayName, MINUTES_NOTES, MINUTES_TITLES } from './labels.ts';

// ---- Daily minutes ----

export function MinutesOptions({ value, onChange, legend = 'Minutes each day' }: {
  value: DailyMinutes;
  onChange: (minutes: DailyMinutes) => void;
  legend?: string;
}) {
  const name = useId();
  return (
    <fieldset className="hm-options">
      <legend className="visually-hidden">{legend}</legend>
      {DAILY_MINUTES.map((m) => (
        <label key={m} className={m === value ? 'hm-option selected' : 'hm-option'}>
          <input type="radio" name={name} value={m} checked={m === value} onChange={() => onChange(m)} />
          <span className="hm-option-main">
            <span className="hm-option-title">{m} min a day · {MINUTES_TITLES[m]}</span>
            <span className="hm-option-detail">At this pace: {MINUTES_NOTES[m]}.</span>
          </span>
          {m === DEFAULT_MINUTES && <span className="chip ai">Suggested</span>}
        </label>
      ))}
    </fieldset>
  );
}

// ---- If-then cue ----

/**
 * The sentence cueFromDraft writes. The place is optional, and it is what follows the last " at ", so
 * an action like "look at my phone" keeps its own "at".
 */
const CUE_PATTERN = /^After I (.+?)(?: at ((?:(?! at ).)+))?, I open Issho\.?$/;

export interface CueDraft {
  /** "pour my evening tea" */
  action: string;
  /** "the kitchen table" */
  place: string;
  /** 'HH:MM' */
  time: string;
}

export const EMPTY_CUE: CueDraft = { action: '', place: '', time: '20:00' };

/** The stored cue text → the two blanks of the sentence (all of it in the first when it doesn't fit). */
export function cueDraft(cue: HabitCue | undefined): CueDraft {
  if (!cue) return EMPTY_CUE;
  const m = CUE_PATTERN.exec(cue.text.trim());
  return m ? { action: m[1], place: m[2] ?? '', time: cue.time } : { action: cue.text, place: '', time: cue.time };
}

/** The same saved cue (both absent counts as the same). */
export function sameCue(a: HabitCue | undefined, b: HabitCue | undefined): boolean {
  return a?.text === b?.text && a?.time === b?.time;
}

/** The two blanks, tidied: without a repeated "After I" or "at". */
function cueParts(d: CueDraft): { action: string; place: string } {
  return { action: d.action.trim().replace(/^after i\s+/i, ''), place: d.place.trim().replace(/^at\s+/i, '') };
}

/** The two blanks → the cue, or undefined while the first is empty. */
export function cueFromDraft(d: CueDraft): HabitCue | undefined {
  const { action, place } = cueParts(d);
  if (!action || !d.time) return undefined;
  return { text: place ? `After I ${action} at ${place}, I open Issho` : `After I ${action}, I open Issho`, time: d.time };
}

export type CueProblem = 'time' | 'action';

/**
 * pure: why a half-filled cue can't be saved (cueFromDraft would drop it), or undefined when it is complete
 * or left empty on purpose.
 */
export function cueProblem(d: CueDraft): CueProblem | undefined {
  const { action, place } = cueParts(d);
  if (action && !d.time) return 'time';
  if (!action && place) return 'action';
  return undefined;
}

const CUE_PROBLEM_TEXT: Record<CueProblem, string> = {
  time: 'Pick a time for the reminder, or clear the cue.',
  action: 'Say what you already do (“After I …”), or clear the place.',
};

export function CueFields({ draft, onChange, problem }: {
  draft: CueDraft;
  onChange: (d: CueDraft) => void;
  /** Shown with the field it is about (cueProblem). */
  problem?: CueProblem;
}) {
  const id = useId();
  const problemId = `${id}-problem`;
  const about = (field: CueProblem) => (problem === field
    ? { 'aria-invalid': true, 'aria-describedby': problemId } as const
    : {});
  return (
    <div className="hm-cue" role="group" aria-labelledby={`${id}-legend`}>
      <p id={`${id}-legend`} className="hm-field-label">My cue</p>
      <div className="hm-cue-sentence">
        <label className="hm-cue-part" htmlFor={`${id}-action`}>
          <span>After I</span>
          {/* Read on its own, "After I" doesn't say what goes in the blank. */}
          <span className="visually-hidden">: something you already do every day</span>
          <input id={`${id}-action`} className="text-input" value={draft.action} maxLength={80}
            placeholder="pour my evening tea" autoComplete="off" {...about('action')}
            onChange={(e) => onChange({ ...draft, action: e.target.value })} />
        </label>
        <label className="hm-cue-part" htmlFor={`${id}-place`}>
          <span>at</span>
          <span className="visually-hidden">: the place, optional</span>
          <input id={`${id}-place`} className="text-input" value={draft.place} maxLength={80}
            placeholder="the kitchen table" autoComplete="off" onChange={(e) => onChange({ ...draft, place: e.target.value })} />
        </label>
        <p className="hm-cue-end">I open Issho.</p>
      </div>
      <label className="hm-field hm-time-field" htmlFor={`${id}-time`}>
        <span className="hm-field-label">Remind me at</span>
        <input id={`${id}-time`} type="time" className="text-input hm-time" value={draft.time} required {...about('time')}
          onChange={(e) => onChange({ ...draft, time: e.target.value })} />
      </label>
      {problem && <p id={problemId} className="hm-error" role="alert">{CUE_PROBLEM_TEXT[problem]}</p>}
    </div>
  );
}

export function CopingField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="hm-field">
      <label className="hm-field-label" htmlFor={id}>If I miss it…</label>
      <input id={id} className="text-input" value={value} maxLength={120} autoComplete="off"
        placeholder="I do 3 minutes before brushing my teeth" aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)} />
      <p id={`${id}-hint`} className="hm-hint">A backup plan for busy days. Even 3 minutes keeps the habit.</p>
    </div>
  );
}

// ---- Together slots ----

export const SESSION_JOBS: Record<TogetherSlot['session'], string> = {
  A: 'Quiz each other and practise a conversation',
  B: 'A real-life task (the AI can play the clerk)',
  C: "Talk about the week's story, then a short check-in",
};

/** Tuesday, Thursday and Sunday at 20:00. */
export const DEFAULT_SLOTS: TogetherSlot[] = [
  { session: 'A', weekday: 2, time: '20:00' },
  { session: 'B', weekday: 4, time: '20:00' },
  { session: 'C', weekday: 7, time: '20:00' },
];

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Exactly one slot per session letter, A–C, defaults filling any gap. */
export function completeSlots(slots: readonly TogetherSlot[] | undefined): TogetherSlot[] {
  return DEFAULT_SLOTS.map((d) => slots?.find((s) => s.session === d.session) ?? d);
}

export function SlotsEditor({ slots, onChange }: { slots: readonly TogetherSlot[]; onChange: (slots: TogetherSlot[]) => void }) {
  const id = useId();
  const set = (session: TogetherSlot['session'], patch: Partial<TogetherSlot>) =>
    onChange(slots.map((s) => (s.session === session ? { ...s, ...patch } : s)));
  return (
    <ul className="hm-slots">
      {slots.map((slot) => (
        <li key={slot.session} className="hm-slot">
          <div className="hm-slot-head">
            <span className="hm-slot-letter" aria-hidden="true">{slot.session}</span>
            <div>
              <p className="hm-field-label" id={`${id}-${slot.session}`}>Session {slot.session}</p>
              <p className="hm-hint">{SESSION_JOBS[slot.session]}</p>
            </div>
          </div>
          <div className="hm-slot-fields" role="group" aria-labelledby={`${id}-${slot.session}`}>
            <select className="set-select" aria-label={`Session ${slot.session} day`} value={slot.weekday}
              onChange={(e) => set(slot.session, { weekday: Number(e.target.value) as TogetherSlot['weekday'] })}>
              {WEEKDAYS.map((w) => <option key={w} value={w}>{isoWeekdayName(w)}</option>)}
            </select>
            <input type="time" className="text-input hm-time" aria-label={`Session ${slot.session} time`} value={slot.time}
              required onChange={(e) => e.target.value && set(slot.session, { time: e.target.value })} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- Shared goal ----

export interface GoalDraft { text: string; targetDate: string }

export function goalFromDraft(d: GoalDraft): SharedGoal | undefined {
  const text = d.text.trim();
  return text && d.targetDate ? { text, targetDate: d.targetDate } : undefined;
}

export function GoalFields({ draft, onChange, min }: { draft: GoalDraft; onChange: (d: GoalDraft) => void; min?: string }) {
  const id = useId();
  return (
    <div className="hm-goal">
      <div className="hm-field">
        <label className="hm-field-label" htmlFor={`${id}-text`}>Our shared goal</label>
        <input id={`${id}-text`} className="text-input" value={draft.text} maxLength={120} autoComplete="off"
          placeholder="Order dinner in Japanese in Kyoto" onChange={(e) => onChange({ ...draft, text: e.target.value })} />
      </div>
      <div className="hm-field">
        <label className="hm-field-label" htmlFor={`${id}-date`}>By</label>
        <input id={`${id}-date`} type="date" className="text-input hm-date" value={draft.targetDate} min={min}
          onChange={(e) => onChange({ ...draft, targetDate: e.target.value })} />
      </div>
    </div>
  );
}

/** The ground rules for studying together. */
export function PartnerRules() {
  return (
    <section className="card hm-rules" aria-labelledby="partner-rules-title">
      <h2 id="partner-rules-title" className="hm-notice-title">How we practise together</h2>
      <ul>
        <li>One signal when you're lost: <span lang="ja">もう一度？</span>, or point at the word.</li>
        <li>Never explain grammar to each other. Corrections come from the app, privately.</li>
        <li>Take turns: each of you speaks, then the other.</li>
      </ul>
    </section>
  );
}
