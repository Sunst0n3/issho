import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import type { DayRecord } from '../lib/types.ts';
import { addDays, dayStart, daysBetween, emptyDay, getDay, isoWeekday, isStudyDay, normalizeDay, totalNewSec, updateDay, weekStart } from './days.ts';
import { resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

describe('day key arithmetic', () => {
  it('adds days across month, year and daylight-saving boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('counts whole days between keys', () => {
    expect(daysBetween('2026-10-14', '2026-10-21')).toBe(7);
    expect(daysBetween('2026-10-21', '2026-10-14')).toBe(-7);
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('knows the ISO weekday and the 4 a.m. start of a study day', () => {
    expect(isoWeekday('2026-10-12')).toBe(1);
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(dayStart('2026-10-14')).toEqual(new Date(2026, 9, 14, 4));
  });

  it('finds the Monday of the ISO week', () => {
    expect(weekStart('2026-10-12')).toBe('2026-10-12'); // Monday
    expect(weekStart('2026-10-14')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12'); // Sunday belongs to the week before
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
  });
});

describe('DayRecord helpers', () => {
  it('reads missing days as empty and updates them in place', async () => {
    expect(await getDay('2026-10-14')).toEqual(emptyDay('2026-10-14'));
    await updateDay('2026-10-14', (d) => {
      d.reviews += 2;
    });
    await updateDay('2026-10-14', (d) => {
      d.reviews += 1;
    });
    expect((await db.days.get('2026-10-14'))!.reviews).toBe(3);
  });

  it('only treats days with activity as study days', () => {
    expect(isStudyDay(emptyDay('2026-10-14'))).toBe(false);
    const travelDay: DayRecord = { ...emptyDay('2026-10-14'), travel: true };
    expect(isStudyDay(travelDay)).toBe(false);
    const reading: DayRecord = { ...emptyDay('2026-10-14'), strandMs: 30_000, studyMs: 30_000 };
    expect(isStudyDay(reading)).toBe(true);
    expect(isStudyDay({ ...emptyDay('2026-10-14'), reviews: 1 })).toBe(true);
    expect(isStudyDay({ ...emptyDay('2026-10-14'), togetherMs: 1 })).toBe(true);
    expect(isStudyDay({ ...emptyDay('2026-10-14'), minimumDone: true })).toBe(true);
    expect(isStudyDay({ ...emptyDay('2026-10-14'), newItems: 1 })).toBe(true);
  });

  it('does not count a sitting opened and left with nothing in it (QA V026)', () => {
    // An empty Anywhere sitting open for about a second: studyMs only, no review, no lesson, no reading.
    const empty: DayRecord = { ...emptyDay('2026-10-14'), studyMs: 1176 };
    expect(isStudyDay(empty)).toBe(false);
  });

  it('starts every v2 counter at zero', () => {
    expect(emptyDay('2026-10-14')).toEqual({
      date: '2026-10-14', studyMs: 0, togetherMs: 0, reviews: 0, correct: 0, reviewMs: 0, strandMs: 0, newItems: 0,
      newSec: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 }, minimumDone: false, goalMet: false, steps: [],
    });
  });

  it('fills in fields an older row lacks', async () => {
    const old = { date: '2026-10-13', studyMs: 5, reviews: 1, correct: 1, newItems: 0 } as unknown as Parameters<typeof normalizeDay>[0];
    expect(normalizeDay(old, '2026-10-13')).toMatchObject({ studyMs: 5, reviewMs: 0, steps: [], newSec: { kanji: 0 } });
    await db.days.put(old!);
    expect((await getDay('2026-10-13')).newSec.core).toBe(0);
    expect(totalNewSec({ sprint: 53, kanji: 188, staged: 28, core: 35, grammar: 0 })).toBe(304);
    expect(totalNewSec(undefined)).toBe(0);
  });
});
