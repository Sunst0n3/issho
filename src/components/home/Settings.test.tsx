import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey, db, getSettings, updateSettings } from '../../lib/db.ts';
import Settings from '../../screens/Settings.tsx';
import { markSentencesShown } from '../../srs/planner.ts';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);
vi.mock('../together/ConnectServerForm.tsx', () => ({
  ConnectServerForm: () => <p>Pairing form</p>,
}));
// The paired view asks the home server for its status; there is no server here.
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  health: async () => ({ ok: true as const, version: 'test', aiEnabled: false }),
}));
vi.mock('../../sync/stats.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/stats.ts')>()),
  useHousehold: () => ({ loading: false, refresh: async () => {} }),
}));

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam' });
  await addLearned('kanji', '日');
  await addLearned('kanji', '水', { lapses: 2 });
  await db.days.put({ date: dayKey(), studyMs: 1000, reviews: 3, correct: 2, newItems: 2, sessionComplete: true });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

async function openReset() {
  renderAt('/settings', '/settings', <Settings />);
  const data = (await screen.findByRole('heading', { name: 'Data' })).closest('section')!;
  fireEvent.click(within(data).getByRole('button', { name: 'Reset all progress' }));
  return data;
}

describe('Settings: reset all progress', () => {
  it('only deletes after the learner types "reset"', async () => {
    const data = await openReset();
    const confirm = within(data).getByRole('button', { name: 'Delete all progress' }) as HTMLButtonElement;
    const input = within(data).getByLabelText('Type “reset” to confirm');
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'rese' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'reset' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(await within(data).findByText('All progress was reset. Today starts fresh.')).toBeTruthy();
    expect(await db.items.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
    expect(await db.days.count()).toBe(0);
    // Settings (name, onboarding) are kept.
    expect(await getSettings()).toMatchObject({ name: 'Sam', onboarded: true });
  });

  it('clears every progress table and keeps settings and the chat with the household', async () => {
    const kept = new Set(['settings', 'messages', 'outbox']);
    await db.reviewLogs.add({
      cardId: 'kanji:日|meaning', itemId: 'kanji:日', grade: 3, reviewedAt: new Date(), durationMs: 4000, mode: 'choice', prevState: 2,
    });
    await db.savedSentences.add({ id: 's-1', jp: '{日|ひ}', en: 'day', savedAt: new Date() });
    await db.messages.add({ id: 1, clientId: 'c-1', memberId: 'm-anna', createdAt: new Date().toISOString(), kind: 'text', text: 'おはよう' });
    await db.outbox.add({ clientId: 'c-2', createdAt: new Date(), kind: 'text', text: 'おやすみ', attempts: 0 });
    for (const table of db.tables) expect(await table.count(), table.name).toBeGreaterThan(0);
    markSentencesShown(['s-1']);

    const data = await openReset();
    fireEvent.change(within(data).getByLabelText('Type “reset” to confirm'), { target: { value: 'reset' } });
    fireEvent.click(within(data).getByRole('button', { name: 'Delete all progress' }));
    await within(data).findByText('All progress was reset. Today starts fresh.');

    for (const table of db.tables) {
      expect(await table.count(), table.name).toBe(kept.has(table.name) ? 1 : 0);
    }
    expect(localStorage.getItem('issho.srs.sentencesShown')).toBeNull();
  });

  it('can be cancelled without touching anything', async () => {
    const data = await openReset();
    fireEvent.change(within(data).getByLabelText('Type “reset” to confirm'), { target: { value: 'reset' } });
    fireEvent.click(within(data).getByRole('button', { name: 'Cancel' }));
    expect(within(data).queryByRole('button', { name: 'Delete all progress' })).toBeNull();
    expect(within(data).getByRole('button', { name: 'Reset all progress' })).toBeTruthy();
    expect(await db.items.count()).toBe(2);
  });
});

describe('Settings', () => {
  it('saves study choices', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = (await screen.findByRole('heading', { name: 'Study' })).closest('section')!;
    fireEvent.click(within(study).getByRole('button', { name: 'More new items' }));
    fireEvent.click(within(study).getByRole('radio', { name: 'Never' }));
    fireEvent.click(within(study).getByRole('switch', { name: 'Show romaji' }));
    await waitFor(async () => expect(await getSettings()).toMatchObject({ newPerDay: 6, furigana: 'never', romaji: false }));
  });

  it('switches the theme and remembers it', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const look = (await screen.findByRole('heading', { name: 'Appearance' })).closest('section')!;
    fireEvent.click(within(look).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('issho.theme')).toBe('dark');
    fireEvent.click(within(look).getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('issho.theme')).toBeNull();
  });

  it('offers to connect when this phone is not paired', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const together = (await screen.findByRole('heading', { name: 'Together' })).closest('section')!;
    expect(within(together).getByText('Pairing form')).toBeTruthy();
  });

  it('disconnects this phone only after confirming', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    renderAt('/settings', '/settings', <Settings />);
    const together = (await screen.findByRole('heading', { name: 'Together' })).closest('section')!;
    expect(await within(together).findByText('Our home')).toBeTruthy();

    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    fireEvent.click(within(together).getByRole('button', { name: 'Cancel' }));
    expect((await getSettings()).deviceToken).toBe('token');

    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    expect(within(together).getByText('Disconnect this phone?')).toBeTruthy();
    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect' }));
    expect(await within(together).findByText('Pairing form')).toBeTruthy();
    expect(await getSettings()).toMatchObject({ deviceToken: undefined, memberId: undefined, name: 'Sam' });
  });
});
