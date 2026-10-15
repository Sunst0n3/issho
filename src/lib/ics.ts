// Calendar reminders as an .ics file (RFC 5545): the daily if-then cue and the weekly together
// slots. Built and downloaded on the phone, so it works offline and needs no server.
//
// Event times are floating local times (no TZID, no Z): "20:00" stays 20:00 wherever the phone is.
// DTSTAMP (when the file was made) is the one UTC value, as RFC 5545 requires. With SEQUENCE it lets
// a calendar replace the events of an earlier download (same UIDs) after the times change.

import type { HabitCue, TogetherSlot } from './types.ts';

export interface IcsInput {
  /** Daily cue reminder ('HH:MM'). */
  cue?: HabitCue;
  slots: readonly TogetherSlot[];
  /** First day of the reminders ('YYYY-MM-DD'). */
  start: string;
  name: string;
  partnerName?: string;
  /** For stable UIDs. */
  uidSeed: string;
}

/** ISO weekday (1 = Monday … 7 = Sunday) → RRULE BYDAY code. */
const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

const CUE_MINUTES = 10;
const SLOT_MINUTES = 15;
const SLOT_ALARM = '-PT10M';
/** SEQUENCE counts minutes from here (2026-01-01 UTC). */
const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);

const SESSION_JOBS: Record<TogetherSlot['session'], string> = {
  A: 'quiz and conversation',
  B: 'a real-life task',
  C: 'story talk and check-in',
};

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): each continuation line starts with one space,
 * which counts toward its 75. A multi-byte character is never split.
 */
export function foldLine(line: string): string {
  if (octets(line) <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = octets(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (size + n > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

function parseDay(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** ISO weekday of a day key (1 = Monday … 7 = Sunday). */
function isoWeekday(key: string): number {
  const { y, m, d } = parseDay(key);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function addDays(key: string, n: number): string {
  const { y, m, d } = parseDay(key);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

/** The first day on or after `start` that falls on `weekday`. */
function firstOn(start: string, weekday: number): string {
  return addDays(start, (weekday - isoWeekday(start) + 7) % 7);
}

/** 'HH:MM' → 'HHMM00', or null when it isn't a time. */
function timePart(time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}${m[2]}00`;
}

/** Floating local date-time: '2026-10-20' + '20:00' → '20261020T200000'. */
function localDateTime(day: string, time: string): string | null {
  const t = timePart(time);
  return t ? `${day.replace(/-/g, '')}T${t}` : null;
}

/** A stable identifier for one reminder: the same input gives the same UID, so a re-import updates instead of duplicating. */
function uid(seed: string, what: string): string {
  // FNV-1a, 32-bit: enough to keep UIDs short and free of the learner's text.
  let h = 0x811c9dc5;
  for (const ch of `${seed}|${what}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${what}-${h.toString(16).padStart(8, '0')}@issho`;
}

interface EventSpec {
  uid: string;
  start: string;
  minutes: number;
  rrule: string;
  summary: string;
  description?: string;
  alarm: string;
}

function eventLines(e: EventSpec, stamp: string, sequence: number): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${e.start}`,
    `DURATION:PT${e.minutes}M`,
    `RRULE:${e.rrule}`,
    `SUMMARY:${escapeText(e.summary)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  lines.push(
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(e.summary)}`,
    `TRIGGER:${e.alarm}`,
    'END:VALARM',
    'END:VEVENT',
  );
  return lines;
}

/** RFC 5545 text, CRLF line endings, lines folded at 75 octets. Floating local times (no TZID, no Z).
 *  The cue is a DAILY event ("Issho — <cue text>", 10 min) with a 0-min VALARM.
 *  Slots: one WEEKLY event per session letter (RRULE:FREQ=WEEKLY;BYDAY=TU…) at its time, 15 min, VALARM -PT10M.
 *  DTSTAMP is `now` in UTC; SEQUENCE counts minutes since 2026, so a later download outranks an earlier one.
 *  No guilt copy. */
export function buildIcs(input: IcsInput, now: Date = new Date()): string {
  const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const sequence = Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000));
  const events: EventSpec[] = [];

  const cueText = input.cue?.text.trim();
  const cueStart = input.cue && cueText ? localDateTime(input.start, input.cue.time) : null;
  if (input.cue && cueText && cueStart) {
    events.push({
      uid: uid(input.uidSeed, 'cue'),
      start: cueStart,
      minutes: CUE_MINUTES,
      rrule: 'FREQ=DAILY',
      summary: `Issho — ${cueText}`,
      description: 'A few minutes of Japanese. Even 3 minutes counts.',
      alarm: 'PT0M',
    });
  }

  const partner = input.partnerName?.trim();
  const seen = new Set<string>();
  for (const slot of input.slots) {
    // One event per session letter: a repeated letter keeps the first slot.
    if (seen.has(slot.session) || !BYDAY[slot.weekday]) continue;
    const start = localDateTime(firstOn(input.start, slot.weekday), slot.time);
    if (!start) continue;
    seen.add(slot.session);
    events.push({
      uid: uid(input.uidSeed, `session-${slot.session}`),
      start,
      minutes: SLOT_MINUTES,
      rrule: `FREQ=WEEKLY;BYDAY=${BYDAY[slot.weekday]}`,
      summary: `Issho together — Session ${slot.session}${partner ? ` with ${partner}` : ''}`,
      description: `15 minutes together: ${SESSION_JOBS[slot.session]}.`,
      alarm: SLOT_ALARM,
    });
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Issho//Reminders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(input.name.trim() ? `Issho · ${input.name.trim()}` : 'Issho')}`,
    ...events.flatMap((e) => eventLines(e, stamp, sequence)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export const ICS_FILE_NAME = 'issho-reminders.ics';

/** Saves the calendar file. Opening it on a phone offers to add the events to the calendar. */
export function downloadIcs(text: string, fileName: string = ICS_FILE_NAME): void {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking straight away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
