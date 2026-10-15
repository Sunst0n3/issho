import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismiss, isDismissed, loadHabitSnapshot } from './habitData.ts';

const habits = vi.hoisted(() => ({
  streak: vi.fn(async () => ({ current: 3, alive: true })),
  comeback: vi.fn(async () => ({ kind: 'welcome-back', missedDays: 1 })),
}));
vi.mock('../../srs/habits.ts', () => habits);

// 2026-10-15 is a Thursday; 02:00 is still the study day of the 14th (rollover at 4 a.m.).
const LATE_NIGHT = new Date(2026, 9, 15, 2, 0);

beforeEach(() => localStorage.clear());
afterEach(() => vi.clearAllMocks());

describe('loadHabitSnapshot', () => {
  it("joins the streak and the comeback offer for the study day, at the same moment", async () => {
    const snap = await loadHabitSnapshot(LATE_NIGHT);
    expect(snap.today).toBe('2026-10-14');
    expect(snap.streak).toMatchObject({ current: 3 });
    expect(snap.comeback).toEqual({ kind: 'welcome-back', missedDays: 1 });
    expect(habits.streak).toHaveBeenCalledWith(LATE_NIGHT);
    expect(habits.comeback).toHaveBeenCalledWith(LATE_NIGHT);
  });
});

describe('dismissed prompts', () => {
  it('stay put away for the rest of the study day only', () => {
    dismiss('comeback', '2026-10-15');
    expect(isDismissed('comeback', '2026-10-15')).toBe(true);
    expect(isDismissed('comeback', '2026-10-16')).toBe(false);
    expect(isDismissed('rest-token', '2026-10-15')).toBe(false);
  });

  it('survive garbled storage', () => {
    localStorage.setItem('issho.today.dismissed', '{nope');
    expect(isDismissed('comeback', '2026-10-15')).toBe(false);
    dismiss('comeback', '2026-10-15');
    expect(isDismissed('comeback', '2026-10-15')).toBe(true);
  });
});
