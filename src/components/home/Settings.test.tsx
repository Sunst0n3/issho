import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdResponse, MemberStats } from '../../../shared/api.ts';
import { dayKey, db, getSettings, updateSettings } from '../../lib/db.ts';
import Settings from '../../screens/Settings.tsx';
import { markSentencesShown } from '../../srs/planner.ts';
import { markAiBroken, resetAiAvailability } from '../together/ai.ts';
import { resetNameSync } from './nameSync.ts';
import { voiceLabel } from './SettingsStudy.tsx';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

const server = vi.hoisted(() => ({
  renameMember: vi.fn(async (name: string) => ({ id: 'm-sam', name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null })),
  household: undefined as HouseholdResponse | undefined,
  aiEnabled: false,
}));

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);
vi.mock('../together/ConnectServerForm.tsx', () => ({
  ConnectServerForm: () => <p>Pairing form</p>,
}));
// The paired view asks the home server for its status; there is no server here.
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  health: async () => ({ ok: true as const, version: 'test', aiEnabled: server.aiEnabled }),
  renameMember: server.renameMember,
}));
vi.mock('../../sync/stats.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/stats.ts')>()),
  useHousehold: () => ({ data: server.household, loading: false, refresh: async () => {} }),
  refreshHousehold: async () => {},
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
  server.renameMember.mockClear();
  server.household = undefined;
  resetNameSync();
  vi.useRealTimers();
});

function member(id: string, name: string): MemberStats {
  return {
    member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
    days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 2, updatedAt: null,
  };
}

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

  it('moves focus into the confirmation and back to the button on Cancel', async () => {
    const data = await openReset();
    expect(document.activeElement).toBe(within(data).getByLabelText('Type “reset” to confirm'));
    fireEvent.click(within(data).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(within(data).getByRole('button', { name: 'Reset all progress' }));
  });
});

describe('Settings', () => {
  it('has a real page heading', async () => {
    renderAt('/settings', '/settings', <Settings />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /can't work offline/ })).toBeNull();
  });

  it('warns when opened from an insecure (http://) address', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    try {
      renderAt('/settings', '/settings', <Settings />);
      expect(await screen.findByRole('heading', { name: "Issho can't work offline from this address" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    }
  });

  it("keeps the last name when the field is emptied, and asks for one", async () => {
    renderAt('/settings', '/settings', <Settings />);
    const input = (await screen.findByLabelText('Your name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText(/Add a name/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await new Promise((r) => setTimeout(r, 650));
    expect((await getSettings()).name).toBe('Sam');

    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('Sam'));
    expect(screen.queryByText(/Add a name/)).toBeNull();
  });

  it('renames this member on the home server after saving a new name', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam' });
    renderAt('/settings', '/settings', <Settings />);
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Sam C' } });
    await waitFor(() => expect(server.renameMember).toHaveBeenCalledWith('Sam C'), { timeout: 2000 });
    expect((await getSettings()).name).toBe('Sam C');
    expect(server.renameMember).toHaveBeenCalledTimes(1);
  });

  it("doesn't call the home server from a phone that isn't paired", async () => {
    renderAt('/settings', '/settings', <Settings />);
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Sam C' } });
    await waitFor(async () => expect((await getSettings()).name).toBe('Sam C'), { timeout: 2000 });
    expect(server.renameMember).not.toHaveBeenCalled();
  });

  it('sends the name again when the home server still has an older one (a rename that failed)', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', name: 'Sam C' });
    server.household = { householdName: 'Our home', me: 'm-sam', members: [member('m-sam', 'Sam'), member('m-anna', 'Anna')], sharedStreak: 0 };
    renderAt('/settings', '/settings', <Settings />);
    await waitFor(() => expect(server.renameMember).toHaveBeenCalledWith('Sam C'));
  });

  it('counts only the script just marked as known', async () => {
    await updateSettings({ knowsKatakana: true });
    renderAt('/settings', '/settings', <Settings />);
    const kana = (await screen.findByRole('heading', { name: 'Kana' })).closest('section')!;
    fireEvent.click(within(kana).getByRole('switch', { name: 'I already know hiragana' }));
    // The fixtures have 5 hiragana and 5 katakana.
    expect(await within(kana).findByText('Done: 5 hiragana are now in your reviews as known.')).toBeTruthy();
  });

  it('shortens voice names for the picker', () => {
    expect(voiceLabel('Flo (Japanese (Japan))')).toBe('Flo');
    expect(voiceLabel('Grandma (Japanese (Japan))')).toBe('Grandma');
    expect(voiceLabel('Microsoft Nanami Online (Natural) - Japanese (Japan)')).toBe('Microsoft Nanami Online (Natural)');
    expect(voiceLabel('Kyoko')).toBe('Kyoko');
    expect(voiceLabel('Google 日本語')).toBe('Google 日本語');
  });

  it('gives the credit links their own row of full-size targets', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const about = (await screen.findByRole('heading', { name: 'About' })).closest('section')!;
    for (const name of ['KanjiVG', 'CC BY-SA 3.0', 'KANJIDIC2', 'JMdict', 'EDRDG', 'CC BY-SA 4.0']) {
      expect(within(about).getByRole('link', { name }).parentElement?.className).toBe('set-credit-links');
    }
  });

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
    // Focus moves into the confirmation, and back to the button on Cancel.
    expect(document.activeElement).toBe(within(together).getByText('Disconnect this phone?'));
    fireEvent.click(within(together).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    expect((await getSettings()).deviceToken).toBe('token');

    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    expect(within(together).getByText('Disconnect this phone?')).toBeTruthy();
    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect' }));
    expect(await within(together).findByText('Pairing form')).toBeTruthy();
    expect(await getSettings()).toMatchObject({ deviceToken: undefined, memberId: undefined, name: 'Sam' });
    // The confirmation is gone with its buttons: focus stays in the section.
    expect(document.activeElement).toBe(within(together).getByText(/Connect to your home server/));
  });

  it("says the AI helper isn't working when the chat found it broken, even though the server has it on", async () => {
    server.aiEnabled = true;
    try {
      await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
      renderAt('/settings', '/settings', <Settings />);
      const together = (await screen.findByRole('heading', { name: 'Together' })).closest('section')!;
      expect(await within(together).findByText(/^On: private tips/)).toBeTruthy();
      act(() => markAiBroken('ai_misconfigured'));
      expect(await within(together).findByText(/Not working: the home server's API key/)).toBeTruthy();
      act(() => resetAiAvailability());
      act(() => markAiBroken('ai_unavailable'));
      expect(await within(together).findByText(/Not working right now/)).toBeTruthy();
    } finally {
      server.aiEnabled = false;
      resetAiAvailability();
    }
  });
});
