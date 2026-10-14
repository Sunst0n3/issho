import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import { addDays, daysBetween, emptyDay, getDay, isStudyDay, updateDay, weekStart } from './days.ts';
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
    expect(isStudyDay({ ...emptyDay('2026-10-14'), restDay: true })).toBe(false);
    expect(isStudyDay({ ...emptyDay('2026-10-14'), studyMs: 1 })).toBe(true);
  });
});
