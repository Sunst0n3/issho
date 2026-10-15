// Calendar reminders: an .ics file with the daily cue and the together slots. Built on the phone,
// so it works offline. Used by onboarding and by Settings → Habits.
import { useState } from 'react';
import { buildIcs, downloadIcs, type IcsInput } from '../../lib/ics.ts';
import type { HabitCue, TogetherSlot } from '../../lib/types.ts';
import { Icon } from '../ui.tsx';
import { isoWeekdayName } from './labels.ts';

const UID_KEY = 'issho.ics.uid';

/**
 * The seed that keeps reminder UIDs stable on this phone, so downloading again updates the
 * calendar's events instead of adding copies. The first seed used on the phone is kept: onboarding
 * offers the file before the connect step, so pairing afterwards must not change it. That is the
 * member id when the phone was already paired, otherwise a random id (a lost one only means the
 * next file adds new events).
 */
export function reminderSeed(memberId: string | undefined): string {
  try {
    let seed = localStorage.getItem(UID_KEY);
    if (!seed) {
      seed = memberId
        ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2));
      localStorage.setItem(UID_KEY, seed);
    }
    return seed;
  } catch {
    return memberId ?? 'issho';
  }
}

export function AddToCalendar({ input, label = 'Add to calendar' }: { input: IcsInput; label?: string }) {
  const [saved, setSaved] = useState(false);
  const nothing = !input.cue && input.slots.length === 0;
  return (
    <div className="hm-ics">
      <button type="button" className="btn secondary" disabled={nothing}
        onClick={() => { downloadIcs(buildIcs(input)); setSaved(true); }}>
        <Icon name="calendar" size={18} />{label}
      </button>
      {saved && <p className="hm-ok" role="status">Saved issho-reminders.ics. Open it to add the reminders to your calendar.</p>}
    </div>
  );
}

export function RemindersStep({ cue, slots, input }: { cue?: HabitCue; slots: readonly TogetherSlot[]; input: IcsInput }) {
  return (
    <div className="hm-reminders">
      <ul className="card hm-reminder-list">
        {cue ? (
          <li><strong>Every day at {cue.time}</strong><span className="hm-hint">{cue.text}</span></li>
        ) : (
          <li><span className="hm-hint">No daily cue yet. You can add one later in Settings.</span></li>
        )}
        {slots.map((s) => (
          <li key={s.session}>
            <strong>Session {s.session} · {isoWeekdayName(s.weekday)}s at {s.time}</strong>
            <span className="hm-hint">15 minutes together, with a reminder 10 minutes before</span>
          </li>
        ))}
      </ul>
      <AddToCalendar input={input} />
      <p className="hm-hint">The file works with Apple, Google and Outlook calendars, and needs no connection.</p>
    </div>
  );
}
