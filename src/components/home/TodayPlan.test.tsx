// Today with the real planner (Today.test.tsx stubs it): showing the plan must
// never introduce anything. Items are only introduced inside a session.
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import Today from '../../screens/Today.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam', newPerDay: 3 });
});

afterEach(cleanup);

it("previews today's new kana without introducing them", async () => {
  renderAt('/', '/', <Today />);
  const preview = (await screen.findByRole('heading', { name: 'New today' })).closest('section')!;
  await waitFor(() => expect(preview.textContent).toContain('あ'));
  expect(preview.textContent).toContain('い');
  const panel = screen.getByRole('heading', { name: "Today's session" }).closest('section')!;
  expect(panel.textContent).toContain('3new kana');

  expect(await db.items.count()).toBe(0);
  expect(await db.cards.count()).toBe(0);
  expect(await db.days.count()).toBe(0);
});
