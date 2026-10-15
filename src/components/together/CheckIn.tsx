// Session C's weekly check-in: the week's numbers (filled in), one can-do each partner managed
// (a tick for the check-in only: awarding a can-do still takes its own check), next week's slots
// (filed under next week, so this week's sessions stay where they are) and the rest days planned
// for next week (the ones already planned start ticked).

import { useEffect, useId, useState } from 'react';
import type { TogetherSlot, WeeklyCheckin } from '../../../shared/api.ts';
import { db, updateSettings } from '../../lib/db.ts';
import type { UnitSpec } from '../../lib/types.ts';
import { addDays } from '../../srs/days.ts';
import { cancelPlannedToken, spendRestToken } from '../../srs/habits.ts';
import { weeklyCheckinCounts } from '../../srs/together.ts';
import { postTogetherEvent } from '../../sync/together.ts';
import { dateFromKey } from './household.ts';

export const DEFAULT_SLOTS: TogetherSlot[] = [
  { session: 'A', weekday: 2, time: '20:00' },
  { session: 'B', weekday: 4, time: '20:00' },
  { session: 'C', weekday: 7, time: '19:30' },
];
/** Rest tokens per ISO week (habits.ts allows two). */
const MAX_PLANNED_REST = 2;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function sameSlots(a: readonly TogetherSlot[], b: readonly TogetherSlot[]): boolean {
  const key = (s: readonly TogetherSlot[]) => [...s].map((x) => `${x.session}${x.weekday}${x.time}`).sort().join();
  return key(a) === key(b);
}

export function CheckIn({ week, units, settledUnit, slots, shared = slots.length > 0, onSaved }: {
  /** This week's Monday. */
  week: string;
  units: readonly UnitSpec[];
  settledUnit: number;
  /** The slots the couple plans with (the household's, else this phone's own); [] when there are none yet. */
  slots: readonly TogetherSlot[];
  /** The household has slots already. When it has none, the slots saved here become theirs even unchanged. */
  shared?: boolean;
  onSaved(): void;
}) {
  const id = useId();
  const [counts, setCounts] = useState<WeeklyCheckin['counts']>();
  const [canDo, setCanDo] = useState('');
  const [note, setNote] = useState('');
  /** The slots the form opened with. Only edits made here are posted, so an unchanged form never
   *  overwrites slots the partner's check-in changed meanwhile. */
  const [shownSlots] = useState<TogetherSlot[]>(() => (slots.length ? [...slots] : DEFAULT_SLOTS));
  const [nextSlots, setNextSlots] = useState<TogetherSlot[]>(shownSlots);
  /** Rest days planned for next week: those already planned (here or on Today), then this form's ticks. */
  const [rest, setRest] = useState<string[]>([]);
  const [plannedBefore, setPlannedBefore] = useState<string[]>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let alive = true;
    weeklyCheckinCounts(week).then((c) => { if (alive) setCounts(c); }, () => {
      if (alive) setCounts({ kanji: 0, words: 0, grammar: 0, minutes: 0 });
    });
    return () => { alive = false; };
  }, [week]);

  useEffect(() => {
    let alive = true;
    db.restTokens.where('week').equals(addDays(week, 7)).primaryKeys().then(
      (dates) => {
        if (!alive) return;
        const planned = dates.map(String).sort();
        setPlannedBefore(planned);
        setRest(planned);
      },
      () => { if (alive) setPlannedBefore([]); },
    );
    return () => { alive = false; };
  }, [week]);

  const nextWeek = Array.from({ length: 7 }, (_, i) => addDays(week, 7 + i));
  const choices = units
    .filter((u) => u.id <= settledUnit + 1)
    .flatMap((u) => u.canDos.filter((c) => c.ready).map((c) => ({ id: c.id, text: c.text, unit: u.id })));

  const save = async () => {
    if (saving || !counts) return;
    setSaving(true);
    setNotice(undefined);
    const checkin: WeeklyCheckin = { counts };
    if (canDo) checkin.canDo = canDo;
    if (note.trim()) checkin.note = note.trim();
    // Unticked days give their token back first, so a moved rest day fits the two a week.
    for (const date of plannedBefore ?? []) {
      if (!rest.includes(date)) await cancelPlannedToken(date).catch(() => {});
    }
    const planned: string[] = [];
    for (const date of [...rest].sort()) {
      const result = await spendRestToken(date).catch(() => 'not-allowed' as const);
      if (result === 'ok' || result === 'already') planned.push(date);
    }
    if (planned.length) checkin.plannedRest = planned;
    try {
      await postTogetherEvent({ type: 'checkin', checkin });
      if (!shared) {
        // The couple's first slots: they plan this week too.
        await postTogetherEvent({ type: 'slots', slots: nextSlots });
        await updateSettings({ togetherSlots: nextSlots });
      } else if (!sameSlots(nextSlots, shownSlots)) {
        // Filed under next week: this week's sessions stay on the days they were planned, here too (Settings follow
        // the household's slots in effect, and take these next Monday).
        await postTogetherEvent({ type: 'slots', slots: nextSlots }, dateFromKey(nextWeek[0]));
      }
      if (planned.length < rest.length) setNotice('Some rest days could not be planned: two a week at most.');
      onSaved();
    } catch {
      setNotice("The check-in couldn't be saved on this phone. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const setSlot = (session: TogetherSlot['session'], patch: Partial<TogetherSlot>) =>
    setNextSlots((list) => {
      const others = list.filter((s) => s.session !== session);
      const current = list.find((s) => s.session === session) ?? DEFAULT_SLOTS.find((s) => s.session === session)!;
      return [...others, { ...current, ...patch }].sort((a, b) => a.session.localeCompare(b.session));
    });

  return (
    <section className="card tg-checkin" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Weekly check-in</h2>
      {!counts ? <div className="tg-skeleton-line" aria-busy="true" /> : (
        <dl className="tg-stat-row">
          <div className="tg-stat"><dt>Kanji</dt><dd>{counts.kanji}</dd></div>
          <div className="tg-stat"><dt>Words</dt><dd>{counts.words}</dd></div>
          <div className="tg-stat"><dt>Grammar</dt><dd>{counts.grammar}</dd></div>
          <div className="tg-stat"><dt>Minutes</dt><dd>{Math.round(counts.minutes)}</dd></div>
        </dl>
      )}

      <fieldset className="tg-option-group">
        <legend className="label">One thing you managed this week</legend>
        <p className="muted tg-small">This ticks the check-in only. A can-do counts once you pass its check.</p>
        <select className="tg-select" value={canDo} onChange={(e) => setCanDo(e.target.value)} aria-label="Can-do you managed">
          <option value="">Nothing to pick this week</option>
          {choices.map((c) => <option key={c.id} value={c.id}>Unit {c.unit}: {c.text}</option>)}
        </select>
        <textarea className="tg-textarea" rows={2} value={note} maxLength={500} placeholder="A note for the week (optional)"
          aria-label="Note" onChange={(e) => setNote(e.target.value)} />
      </fieldset>

      <fieldset className="tg-option-group">
        <legend className="label">Next week's sessions</legend>
        {(['A', 'B', 'C'] as const).map((session) => {
          const slot = nextSlots.find((s) => s.session === session) ?? DEFAULT_SLOTS.find((s) => s.session === session)!;
          return (
            <div key={session} className="tg-slot-row">
              <span className="tg-slot-name">Session {session}</span>
              <select className="tg-select" aria-label={`Session ${session} day`} value={slot.weekday}
                onChange={(e) => setSlot(session, { weekday: Number(e.target.value) as TogetherSlot['weekday'] })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </select>
              <input className="tg-time" type="time" aria-label={`Session ${session} time`} value={slot.time}
                onChange={(e) => e.target.value && setSlot(session, { time: e.target.value })} />
            </div>
          );
        })}
      </fieldset>

      <fieldset className="tg-option-group">
        <legend className="label">Rest days you plan for next week (up to {MAX_PLANNED_REST})</legend>
        <div className="tg-rest-days" aria-busy={!plannedBefore}>
          {nextWeek.map((date, i) => {
            const checked = rest.includes(date);
            return (
              <label key={date} className="tg-rest-day">
                <input type="checkbox" checked={checked} disabled={!plannedBefore || (!checked && rest.length >= MAX_PLANNED_REST)}
                  onChange={() => setRest(checked ? rest.filter((d) => d !== date) : [...rest, date])} />
                {WEEKDAYS[i]} {Number(date.slice(8, 10))}
              </label>
            );
          })}
        </div>
      </fieldset>

      {notice && <p className="tg-composer-notice" role="status">{notice}</p>}
      <button type="button" className="btn primary block" disabled={!counts || saving} onClick={() => void save()}>
        Save the check-in
      </button>
      <p className="muted tg-small">Saved on this phone now; it reaches the home server when you're online.</p>
    </section>
  );
}
