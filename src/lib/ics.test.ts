import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIcs, downloadIcs, escapeText, foldLine, type IcsInput } from './ics.ts';

const BASE: IcsInput = {
  // 2026-10-19 is a Monday.
  start: '2026-10-19',
  name: 'Sam',
  partnerName: 'Anna',
  uidSeed: 'm-sam',
  slots: [
    { session: 'A', weekday: 2, time: '20:00' },
    { session: 'B', weekday: 4, time: '20:00' },
    { session: 'C', weekday: 7, time: '19:30' },
  ],
  cue: { text: 'After I pour my evening tea at the kitchen table, I open Issho', time: '21:15' },
};

/** The unfolded content lines. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

function events(ics: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT') { out.push(current!); current = null; }
    else current?.push(line);
  }
  return out;
}

describe('buildIcs', () => {
  it('makes one weekly event per together slot on its weekday and time', () => {
    const slots = events(buildIcs(BASE)).filter((e) => e.some((l) => l.startsWith('RRULE:FREQ=WEEKLY')));
    expect(slots).toHaveLength(3);
    const pick = (e: string[], key: string) => e.find((l) => l.startsWith(`${key}:`));
    expect(slots.map((e) => pick(e, 'RRULE'))).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'RRULE:FREQ=WEEKLY;BYDAY=TH',
      'RRULE:FREQ=WEEKLY;BYDAY=SU',
    ]);
    expect(slots.map((e) => pick(e, 'DTSTART'))).toEqual([
      'DTSTART:20261020T200000',
      'DTSTART:20261022T200000',
      'DTSTART:20261025T193000',
    ]);
    for (const e of slots) {
      expect(pick(e, 'DURATION')).toBe('DURATION:PT15M');
      expect(e).toContain('TRIGGER:-PT10M');
    }
    expect(pick(slots[0], 'SUMMARY')).toBe('SUMMARY:Issho together — Session A with Anna');
  });

  it('adds the cue as a daily 10-minute event with an alarm at its time', () => {
    const [cue] = events(buildIcs(BASE)).filter((e) => e.includes('RRULE:FREQ=DAILY'));
    expect(cue).toContain('DTSTART:20261019T211500');
    expect(cue).toContain('DURATION:PT10M');
    expect(cue).toContain('TRIGGER:PT0M');
    expect(cue).toContain('SUMMARY:Issho — After I pour my evening tea at the kitchen table\\, I open Issho');
  });

  it('uses floating local times (no TZID and no Z) for the events', () => {
    const ics = buildIcs(BASE);
    expect(ics).not.toContain('TZID');
    for (const line of unfold(ics).filter((l) => l.startsWith('DTSTART'))) expect(line).not.toMatch(/Z$/);
  });

  it('ends every line with CRLF and folds lines at 75 octets', () => {
    const ics = buildIcs({ ...BASE, cue: { text: '毎晩お茶を淹れたら台所のテーブルでイッショを開いて少しだけ日本語を勉強します', time: '21:00' } });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const physical = ics.split('\r\n').slice(0, -1);
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    for (const line of physical) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(physical.some((l) => l.startsWith(' '))).toBe(true);
    // Unfolding gives the summary back whole, with no character split across lines.
    expect(unfold(ics)).toContain('SUMMARY:Issho — 毎晩お茶を淹れたら台所のテーブルでイッショを開いて少しだけ日本語を勉強します');
  });

  it('gives stable UIDs, so a second download updates the same events', () => {
    const uids = (ics: string) => unfold(ics).filter((l) => l.startsWith('UID:'));
    const first = uids(buildIcs(BASE));
    expect(new Set(first).size).toBe(4);
    expect(uids(buildIcs({ ...BASE, slots: [...BASE.slots].reverse() })).sort()).toEqual([...first].sort());
    expect(uids(buildIcs({ ...BASE, uidSeed: 'm-anna' }))).not.toEqual(first);
  });

  it('stamps the download time, and a later download has a higher SEQUENCE so it replaces the events', () => {
    const at = (iso: string) => unfold(buildIcs(BASE, new Date(iso)));
    const first = at('2026-10-20T07:05:09.500Z');
    expect(first.filter((l) => l.startsWith('DTSTAMP:'))).toEqual(Array(4).fill('DTSTAMP:20261020T070509Z'));
    const seq = (lines: string[]) => Number(lines.find((l) => l.startsWith('SEQUENCE:'))!.slice(9));
    expect(seq(at('2026-10-20T07:06:09Z'))).toBe(seq(first) + 1);
  });

  it('leaves out a cue without text and a slot without a valid time', () => {
    const ics = buildIcs({ ...BASE, cue: { text: '  ', time: '21:00' }, slots: [{ session: 'A', weekday: 2, time: 'later' }] });
    expect(events(ics)).toHaveLength(0);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('END:VCALENDAR');
  });

  it('starts a slot on the start day itself when the weekday matches', () => {
    const [slot] = events(buildIcs({ ...BASE, cue: undefined, slots: [{ session: 'A', weekday: 1, time: '7:05' }] }));
    expect(slot).toContain('DTSTART:20261019T070500');
  });

  it('never shames: no "missed" or "streak" wording', () => {
    expect(buildIcs(BASE)).not.toMatch(/miss|streak|don't forget|behind/i);
  });
});

describe('ics helpers', () => {
  it('escapes text values', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });
});

describe('downloadIcs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the text as issho-reminders.ics', () => {
    const create = vi.fn(() => 'blob:ics');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('issho-reminders.ics');
      expect(this.href).toBe('blob:ics');
    });
    downloadIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    expect(click).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/calendar;charset=utf-8');
  });
});
