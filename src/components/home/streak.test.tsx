// The Today streak week: days before the learner's first day are not "missed".
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db.ts';
import { firstStudyDay, streak, streakFromDays } from '../../srs/progress.ts';
import { StreakCard } from './StreakCard.tsx';
import { resetDb } from './test-fixtures.tsx';

const statuses = (info: ReturnType<typeof streakFromDays>) => info.week.map((d) => d.status);

// 2026-10-14 is a Wednesday.
const WEDNESDAY = '2026-10-14';
const wednesdayEvening = new Date(2026, 9, 14, 20, 0);

beforeEach(resetDb);
afterEach(cleanup);

describe('streak week before the first day', () => {
  it('marks past days before the start day as before, not missed', () => {
    const info = streakFromDays([], WEDNESDAY, WEDNESDAY);
    expect(statuses(info)).toEqual(['before', 'before', 'today', 'future', 'future', 'future', 'future']);
  });

  it('still marks days missed after the learner started', () => {
    const info = streakFromDays([WEDNESDAY], WEDNESDAY, '2026-10-13');
    expect(statuses(info)).toEqual(['before', 'missed', 'done', 'future', 'future', 'future', 'future']);
  });

  it('keeps the old behaviour without a start day', () => {
    expect(statuses(streakFromDays([], WEDNESDAY)).slice(0, 2)).toEqual(['missed', 'missed']);
  });

  it('takes the first day from the earliest item or day record, else today', async () => {
    expect(await firstStudyDay(wednesdayEvening)).toBe(WEDNESDAY);

    await db.items.add({ id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: new Date(2026, 9, 13, 9, 0) });
    expect(await firstStudyDay(wednesdayEvening)).toBe('2026-10-13');

    await db.days.put({ date: '2026-10-12', studyMs: 60_000, reviews: 0, correct: 0, newItems: 0, sessionComplete: false });
    expect(await firstStudyDay(wednesdayEvening)).toBe('2026-10-12');
  });

  it('gives a learner who onboarded today a week with nothing missed', async () => {
    await db.items.add({ id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: wednesdayEvening });
    expect(statuses(await streak(wednesdayEvening))).toEqual(['before', 'before', 'today', 'future', 'future', 'future', 'future']);
  });

  it('reads "before you started" to screen readers and words the streak as an n-day streak', () => {
    render(<StreakCard info={{ ...streakFromDays(['2026-10-13', WEDNESDAY], WEDNESDAY, '2026-10-13') }} />);
    expect(screen.getByText('Monday: before you started')).toBeTruthy();
    expect(screen.getByText('Tuesday: studied')).toBeTruthy();
    expect(screen.queryByText(/missed/)).toBeNull();
    expect(screen.getByRole('heading', { name: '2-day streak' })).toBeTruthy();
  });
});
