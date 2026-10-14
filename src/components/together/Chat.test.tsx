import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCheckResponse } from '../../../shared/api.ts';
import { db, updateSettings } from '../../lib/db.ts';
import type { WordEntry } from '../../lib/types.ts';
import Chat from '../../screens/Chat.tsx';
import type { PendingMessage } from '../../sync/outbox.ts';
import { resetAiAvailability, TIMED_OUT } from './ai.ts';
import { lastReadMessageId } from './storage.ts';

const mocks = vi.hoisted(() => ({
  status: 'online' as 'online' | 'offline',
  health: vi.fn(),
  aiCheck: vi.fn(),
  aiTranslate: vi.fn(),
  queueChatMessage: vi.fn(async () => 'client-id'),
  retryMessage: vi.fn(async () => {}),
  discardMessage: vi.fn(async () => {}),
  syncMessages: vi.fn(async () => 0),
  withTimeout: vi.fn(),
}));

vi.mock('./ai.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ai.ts')>();
  mocks.withTimeout.mockImplementation(real.withTimeout);
  return { ...real, withTimeout: mocks.withTimeout };
});

vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  health: mocks.health,
  aiCheck: mocks.aiCheck,
  aiTranslate: mocks.aiTranslate,
}));
vi.mock('../../sync/outbox.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/outbox.ts')>()),
  queueChatMessage: mocks.queueChatMessage,
  retryMessage: mocks.retryMessage,
  discardMessage: mocks.discardMessage,
}));
vi.mock('../../sync/chat.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/chat.ts')>()),
  syncMessages: mocks.syncMessages,
}));
vi.mock('../../sync/socket.ts', () => ({
  useServerStatus: () => mocks.status,
  onServerEvent: () => () => {},
  onStatusChange: () => () => {},
  connectFromSettings: async () => {},
}));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({
    loading: false,
    refresh: async () => {},
    data: {
      householdName: 'Home',
      me: 'me',
      sharedStreak: 0,
      members: [
        { member: { id: 'me', name: 'Aiko', joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 2, updatedAt: null },
        { member: { id: 'ken', name: 'Ken', joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 2, updatedAt: null },
      ],
    },
  }),
  pushStats: async () => true,
}));
vi.mock('../../lib/data.ts', () => ({
  loadWords: async (): Promise<WordEntry[]> => [
    { id: '1', written: '水', kana: 'みず', meanings: ['water'], pos: ['n'], freqRank: 1, kanji: ['水'] },
    { id: '2', written: '飲む', kana: 'のむ', meanings: ['drink'], pos: ['v5m'], freqRank: 1, kanji: ['飲'] },
  ],
}));

const TIP: AiCheckResponse = {
  ok: false,
  corrected: 'きのう すしを 食べました',
  correctedRuby: 'きのう すしを {食|た}べました',
  tips: [{ original: '食べます', suggestion: '食べました', explanation: 'Yesterday needs the past tense.' }],
};

function renderChat() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Chat /></MemoryRouter>);
}

async function typeAndSend(text: string) {
  const input = await screen.findByLabelText('Message in Japanese');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetAiAvailability();
  mocks.status = 'online';
  mocks.health.mockResolvedValue({ ok: true, version: '1', aiEnabled: true });
  await updateSettings({ name: 'Aiko', deviceToken: 'token', memberId: 'me', furigana: 'unknown' });
  await db.messages.bulkPut([
    { id: 1, clientId: 'c1', memberId: 'ken', createdAt: '2026-10-14T09:00:00.000Z', kind: 'text', text: '水を飲みます' },
    { id: 2, clientId: 'c2', memberId: 'me', createdAt: '2026-10-14T09:01:00.000Z', kind: 'text', text: 'いいね' },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Chat', () => {
  it('shows the conversation, marks it read and catches up', async () => {
    renderChat();
    expect(await screen.findByText('いいね')).toBeTruthy();
    expect(screen.getByText('Ken')).toBeTruthy();
    expect(mocks.syncMessages).toHaveBeenCalled();
    await waitFor(() => expect(lastReadMessageId()).toBe(2));
  });

  it('names who wrote each message, and someone no longer in the household as a former member', async () => {
    await db.messages.put({ id: 3, clientId: 'c3', memberId: 'm-gone', createdAt: '2026-10-14T09:02:00.000Z', kind: 'text', text: 'またね' });
    renderChat();
    await screen.findByText('またね');
    const senders = [...document.querySelectorAll('.tg-bubble .visually-hidden')].map((el) => el.textContent);
    expect(senders).toEqual(['Ken: ', 'You: ', 'Former member: ']);
  });

  it('shows pending and failed outbox rows with retry and delete', async () => {
    const rows: PendingMessage[] = [
      { clientId: 'p1', createdAt: new Date('2026-10-14T09:02:00Z'), kind: 'text', text: 'まだです', attempts: 0 },
      { clientId: 'p2', createdAt: new Date('2026-10-14T09:03:00Z'), kind: 'text', text: 'だめでした', attempts: 1, failed: 'too_large' },
    ];
    await db.outbox.bulkPut(rows);
    renderChat();

    expect(await screen.findByText('まだです')).toBeTruthy();
    expect(screen.getByText('Sending…')).toBeTruthy();
    const failed = screen.getByRole('alert');
    expect(failed.textContent).toContain('Not sent');
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    expect(mocks.retryMessage).toHaveBeenCalledWith('p2');
    fireEvent.click(within(failed).getByRole('button', { name: 'Delete' }));
    expect(mocks.discardMessage).toHaveBeenCalledWith('p2');
  });

  it('explains why nothing sends once this phone was removed, and offers to connect again', async () => {
    // What the client leaves behind after a 401 'unauthorized' (see forgetRevokedPairing).
    localStorage.setItem('issho.sync.removed', '1');
    await updateSettings({ deviceToken: undefined, memberId: undefined });
    renderChat();
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('This phone was disconnected.');
    expect(notice.textContent).toContain('Messages you wrote wait here');
    expect(screen.getByLabelText('Household code')).toBeTruthy();
  });

  it('says a pending message is waiting while offline', async () => {
    mocks.status = 'offline';
    await db.outbox.put({ clientId: 'p1', createdAt: new Date(), kind: 'text', text: 'まだです', attempts: 0 });
    renderChat();
    expect(await screen.findByText('Waiting for connection')).toBeTruthy();
  });

  it('shows a private tip and sends the fix without checking again', async () => {
    mocks.aiCheck.mockResolvedValue(TIP);
    renderChat();
    await screen.findByText('いいね');
    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    await screen.findByRole('button', { name: /Stuck\?/ });

    await typeAndSend('きのう すしを 食べます');
    expect(await screen.findByText('Yesterday needs the past tense.')).toBeTruthy();
    expect(screen.getByText(/Only you can see this tip/)).toBeTruthy();
    expect(mocks.aiCheck).toHaveBeenCalledWith(expect.objectContaining({
      text: 'きのう すしを 食べます',
      context: ['Ken: 水を飲みます', 'Me: いいね'],
    }));
    expect(mocks.queueChatMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use the fix' }));
    expect((screen.getByLabelText('Message in Japanese') as HTMLInputElement).value).toBe(TIP.corrected);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: TIP.corrected }));
    expect(mocks.aiCheck).toHaveBeenCalledTimes(1);
  });

  it('can send the original anyway', async () => {
    mocks.aiCheck.mockResolvedValue(TIP);
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('きのう すしを 食べます');
    fireEvent.click(await screen.findByRole('button', { name: 'Send mine anyway' }));
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'きのう すしを 食べます' }));
    expect(screen.queryByText(/Only you can see this tip/)).toBeNull();
  });

  it('sends straight away when the helper finds nothing', async () => {
    mocks.aiCheck.mockResolvedValue({ ok: true, corrected: 'おはよう', correctedRuby: 'おはよう', tips: [] });
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('おはよう');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'おはよう' }));
  });

  it('skips the helper entirely when the server has it off', async () => {
    mocks.health.mockResolvedValue({ ok: true, version: '1', aiEnabled: false });
    renderChat();
    await screen.findByText('いいね');
    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    await typeAndSend('おやすみ');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'おやすみ' }));
    expect(mocks.aiCheck).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Stuck\?/ })).toBeNull();
  });

  it('sends anyway when the check takes too long', async () => {
    mocks.aiCheck.mockReturnValue(new Promise(() => {}));
    let giveUp!: () => void;
    mocks.withTimeout.mockImplementationOnce(() => new Promise((resolve) => { giveUp = () => resolve(TIMED_OUT); }));
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('ただいま');

    expect(await screen.findByText(/Checking your message/)).toBeTruthy();
    expect(mocks.withTimeout).toHaveBeenCalledWith(expect.any(Promise), 10_000);
    expect(mocks.queueChatMessage).not.toHaveBeenCalled();
    giveUp();
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'ただいま' }));
  });

  it('keeps the message being checked from changing under it', async () => {
    await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() });
    mocks.aiCheck.mockReturnValue(new Promise(() => {}));
    let giveUp!: () => void;
    mocks.withTimeout.mockImplementationOnce(() => new Promise((resolve) => { giveUp = () => resolve(TIMED_OUT); }));
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('ただいま');
    await screen.findByText(/Checking your message/);

    // A chip tapped now would be wiped out when the checked text goes.
    const chip = screen.getByRole('button', { name: 'Insert 水' });
    expect(chip).toHaveProperty('disabled', true);
    fireEvent.click(chip);
    giveUp();
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'ただいま' }));
    expect(chip).toHaveProperty('disabled', false);
  });

  it('caps a message at what the server accepts', async () => {
    renderChat();
    const input = await screen.findByLabelText('Message in Japanese');
    expect(input.getAttribute('maxlength')).toBe('2000');
  });

  it('keeps long earlier messages from breaking the check', async () => {
    await db.messages.put({ id: 3, clientId: 'c3', memberId: 'ken', createdAt: '2026-10-14T09:02:00.000Z', kind: 'text', text: 'あ'.repeat(1500) });
    mocks.aiCheck.mockResolvedValue({ ok: true, corrected: 'うん', correctedRuby: 'うん', tips: [] });
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('うん');
    await waitFor(() => expect(mocks.aiCheck).toHaveBeenCalled());
    const { context } = mocks.aiCheck.mock.calls[0][0] as { context: string[] };
    expect(context.at(-1)).toMatch(/^Ken: あ+$/);
    expect(Math.max(...context.map((line) => line.length))).toBeLessThanOrEqual(1000);
  });

  it('stops asking a server that turned out to have the helper off', async () => {
    const { ApiError } = await import('../../sync/client.ts');
    mocks.aiCheck.mockRejectedValue(new ApiError(503, 'ai_disabled'));
    const first = renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('ただいま');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'ただいま' }));
    expect(screen.queryByRole('button', { name: /Stuck\?/ })).toBeNull();
    first.unmount();

    renderChat();
    await screen.findByText('いいね');
    await typeAndSend('おやすみ');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'おやすみ' }));
    expect(mocks.aiCheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Stuck\?/ })).toBeNull();
  });

  it('turns readings for unknown kanji on and off', async () => {
    await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() });
    const { container } = renderChat();
    const toggle = await screen.findByRole('button', { name: 'Show readings over kanji' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // 水 is known, so only 飲 gets its reading.
    await waitFor(() => expect([...container.querySelectorAll('rt')].map((r) => r.textContent)).toEqual(['の']));

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('rt')).toBeNull();
  });

  it('scrolls the whole page to the newest message, past the composer', async () => {
    const page = document.scrollingElement ?? document.documentElement;
    const scrolls = vi.fn();
    page.scrollTo = scrolls;
    // A real page: the composer sticks over the end of the log, so the log's own end isn't enough.
    Object.defineProperty(page, 'scrollHeight', { configurable: true, value: 3000 });
    try {
      const { container } = renderChat();
      await screen.findByText('いいね');
      expect(scrolls).toHaveBeenCalledWith({ top: 3000, behavior: 'auto' });

      // Readings make lines taller: a reader at the bottom stays there.
      const toggle = screen.getByRole('button', { name: 'Show readings over kanji' });
      await waitFor(() => expect(container.querySelector('rt')).not.toBeNull());
      fireEvent.click(toggle);
      scrolls.mockClear();
      fireEvent.click(toggle);
      expect(container.querySelector('rt')).not.toBeNull();
      expect(scrolls).toHaveBeenCalledWith({ top: 3000, behavior: 'auto' });

      // Someone reading older messages is left where they are.
      Object.defineProperty(page, 'scrollHeight', { configurable: true, value: 5000 });
      fireEvent.scroll(window);
      fireEvent.click(toggle);
      scrolls.mockClear();
      fireEvent.click(toggle);
      expect(scrolls).not.toHaveBeenCalled();
    } finally {
      // Back to the prototype's versions.
      Reflect.deleteProperty(page, 'scrollTo');
      Reflect.deleteProperty(page, 'scrollHeight');
    }
  });

  it('inserts a known kanji from the chips', async () => {
    await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() });
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Insert 水' }));
    expect((screen.getByLabelText('Message in Japanese') as HTMLInputElement).value).toBe('水');
  });
});
