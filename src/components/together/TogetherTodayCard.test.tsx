import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { TogetherWeekPlan } from '../../lib/types.ts';
import { addDays } from '../../srs/days.ts';
import { TogetherTodayCard } from './TogetherTodayCard.tsx';

const mocks = vi.hoisted(() => ({ plan: undefined as TogetherWeekPlan | undefined }));
vi.mock('./weekPlan.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./weekPlan.ts')>()),
  useWeekPlan: () => ({ plan: mocks.plan, failed: false, state: null, offline: false }),
}));

const today = dayKey();
const plan = (sessions: TogetherWeekPlan['sessions']): TogetherWeekPlan => ({
  week: '2026-10-12', sessions, settledUnit: 1, monthly: false, showcase: false,
});

function renderCard() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TogetherTodayCard /></MemoryRouter>);
}

beforeEach(async () => {
  await db.settings.clear();
  await updateSettings({ onboarded: true });
});
afterEach(cleanup);

describe('TogetherTodayCard', () => {
  it('shows the session scheduled tonight', async () => {
    mocks.plan = plan([{ id: 'A', day: today, time: '20:00' }]);
    renderCard();
    const link = await screen.findByRole('link', { name: /Session A tonight/ });
    expect(link.getAttribute('href')).toBe('/together/session/A');
    expect(link.textContent).toContain('20:00 · Quiz & conversation');
  });

  it('shows a session still open from earlier this week', async () => {
    mocks.plan = plan([{ id: 'B', day: addDays(today, -2), time: '20:00' }, { id: 'C', day: addDays(today, 3), time: '19:30' }]);
    renderCard();
    expect((await screen.findByRole('link', { name: /Session B still open this week/ })).getAttribute('href')).toBe('/together/session/B');
  });

  it('shows the monthly session on its weekend', async () => {
    mocks.plan = { ...plan([{ id: 'monthly', day: today, time: '10:00' }]), monthly: true };
    renderCard();
    expect(await screen.findByText('Monthly session this weekend')).toBeTruthy();
    expect(screen.getByText('10:00 · quiz, goals, skit')).toBeTruthy();
  });

  it('shows nothing when no session is due, or it is done', async () => {
    mocks.plan = plan([
      { id: 'A', day: today, time: '20:00', doneAt: today },
      { id: 'C', day: addDays(today, 2), time: '19:30' },
    ]);
    const { container } = renderCard();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});
