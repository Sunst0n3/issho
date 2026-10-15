// Settings → Habits: the if-then cue and its time, the coping plan, rest days planned ahead (two a
// week), travel/sick mode, and the calendar reminders.
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useMemo, useState } from 'react';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { Settings } from '../../lib/types.ts';
import { cancelPlannedToken, setTravel, spendRestToken, TOKENS_PER_WEEK, TRAVEL_MAX_DAYS } from '../../srs/habits.ts';
import { useCurrentPlan } from './householdPlan.ts';
import { dayLabel, shiftDay } from './labels.ts';
import { CopingField, cueDraft, CueFields, cueFromDraft, cueProblem, completeSlots, sameCue, type CueDraft } from './planControls.tsx';
import { AddToCalendar, reminderSeed } from './RemindersStep.tsx';
import { SettingsSection } from './SettingsStudy.tsx';
import { useDraft } from './useDraft.ts';

const TOKEN_TEXT = {
  'none-left': 'That week already has its two rest days.',
  'not-allowed': "That day can't take a rest token.",
  already: 'That day is already a rest day.',
} as const;

function RestDays() {
  const id = useId();
  const today = dayKey();
  const planned = useLiveQuery(() => db.restTokens.where('date').above(today).sortBy('date'), [today]);
  const [date, setDate] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const plan = async () => {
    if (!date) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await spendRestToken(date);
      if (result === 'ok') {
        setMessage({ ok: true, text: `${dayLabel(date)} is a rest day.` });
        setDate('');
      } else {
        setMessage({ ok: false, text: TOKEN_TEXT[result] });
      }
    } catch {
      setMessage({ ok: false, text: "Couldn't save that on this phone. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-row">
      <p className="hm-field-label" id={`${id}-title`}>Rest days</p>
      <p className="hm-hint">
        {TOKENS_PER_WEEK} a week. A rest day keeps your streak going. Plan one ahead for a day you know is full.
      </p>
      {planned && planned.length > 0 && (
        <ul className="set-list" aria-labelledby={`${id}-title`}>
          {planned.map((t) => (
            <li key={t.date}>
              <span>{dayLabel(t.date)}</span>
              <button type="button" className="btn ghost small" aria-label={`Cancel the rest day on ${dayLabel(t.date)}`}
                onClick={() => void cancelPlannedToken(t.date)}>
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="set-inline">
        <label className="visually-hidden" htmlFor={`${id}-date`}>Rest day to plan</label>
        <input id={`${id}-date`} type="date" className="text-input hm-date" value={date} min={shiftDay(today, 1)}
          onChange={(e) => setDate(e.target.value)} />
        <button type="button" className="btn secondary small" onClick={() => void plan()} disabled={!date || busy}>
          Plan a rest day
        </button>
      </div>
      {message && <p className={message.ok ? 'hm-ok' : 'hm-error'} role="status">{message.text}</p>}
    </div>
  );
}

function TravelRow({ settings }: { settings: Settings }) {
  const id = useId();
  const today = dayKey();
  // setTravel covers at most TRAVEL_MAX_DAYS days from today; a later end date would leave days that
  // break the streak while this still said "away".
  const latest = shiftDay(today, TRAVEL_MAX_DAYS - 1);
  const away = Boolean(settings.travelUntil && settings.travelUntil >= today);
  const [until, setUntil] = useState(settings.travelUntil && away ? settings.travelUntil : '');
  const valid = Boolean(until) && until >= today && until <= latest;
  const [problem, setProblem] = useState(false);
  const save = async (value: string | null) => {
    setProblem(false);
    try {
      await setTravel(value);
    } catch {
      setProblem(true);
    }
  };
  return (
    <div className="set-row">
      <p className="hm-field-label" id={`${id}-title`}>Travel or sick</p>
      <p className="hm-hint" id={`${id}-hint`}>
        Pauses your streak and new items until the day you pick, up to {TRAVEL_MAX_DAYS} days ahead. Reviews are
        optional, and you ease back in afterwards.
      </p>
      {away && <p className="hm-ok" role="status">Away until {dayLabel(settings.travelUntil!)}.</p>}
      <div className="set-inline">
        <label className="visually-hidden" htmlFor={`${id}-date`}>Away until</label>
        <input id={`${id}-date`} type="date" className="text-input hm-date" value={until} min={today} max={latest}
          aria-describedby={`${id}-hint`} aria-invalid={until && !valid ? true : undefined}
          onChange={(e) => setUntil(e.target.value)} />
        <button type="button" className="btn secondary small" disabled={!valid} onClick={() => void save(until)}>
          {away ? 'Change' : 'Start'}
        </button>
        {away && (
          <button type="button" className="btn ghost small" onClick={() => { setUntil(''); void save(null); }}>I'm back</button>
        )}
      </div>
      {problem && <p className="hm-error" role="alert">Couldn't save that on this phone. Try again.</p>}
    </div>
  );
}

export function HabitsSection({ settings }: { settings: Settings }) {
  // One draft object per saved cue: a new object every render would reset the field while typing.
  const savedDraft = useMemo(() => cueDraft(settings.cue), [settings.cue]);
  const [cue, setCue] = useDraft<CueDraft>(savedDraft, (d) => {
    const next = cueFromDraft(d);
    // Half-typed: keep the saved cue until the sentence has its first blank and a time.
    return next || !d.action.trim() ? updateSettings({ cue: next }) : undefined;
  }, 600, (saved, draft) => sameCue(cueFromDraft(saved), cueFromDraft(draft)));
  const [coping, setCoping] = useDraft(settings.coping ?? '', (v: string) => updateSettings({ coping: v.trim() || undefined }), 600,
    (saved, draft) => saved === draft.trim());
  const savedCue = cueFromDraft(cue);
  // The household's sessions while paired (the partner may have moved one), not only this phone's copy.
  const { slots } = useCurrentPlan(settings);
  return (
    <SettingsSection id="set-habits" title="Habits">
      <div className="set-row">
        {/* A half-filled cue isn't saved (the last whole one stays): say what's missing. */}
        <CueFields draft={cue} onChange={setCue} problem={cueProblem(cue)} />
      </div>
      <div className="set-row">
        <CopingField value={coping} onChange={setCoping} />
      </div>
      <RestDays />
      <TravelRow settings={settings} />
      <div className="set-row">
        <p className="hm-field-label">Calendar reminders</p>
        <p className="hm-hint">Download again after changing your cue or your together times.</p>
        <AddToCalendar label="Download reminders (.ics)"
          input={{
            cue: savedCue,
            slots: slots.length ? completeSlots(slots) : [],
            start: dayKey(),
            name: settings.name,
            uidSeed: reminderSeed(settings.memberId),
          }} />
      </div>
    </SettingsSection>
  );
}
