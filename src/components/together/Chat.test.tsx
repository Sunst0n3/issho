import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCheckResponse, AiIssue, HouseholdResponse, MemberStats } from '../../../shared/api.ts';
import type { WordInfo } from '../../lib/data.ts';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { WordEntry } from '../../lib/types.ts';
import { emptyDay } from '../../srs/days.ts';
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
  aiReport: vi.fn(async () => {}),
  saveOutput: vi.fn(async (rec: object) => ({ ...rec, id: 'out-1', createdAt: new Date() })),
  completeOutputCheck: vi.fn(async () => ({})),
  learnerAiContext: vi.fn(async () => ({ knownKanji: ['水'], knownGrammar: ['ta-form'], knownWords: ['すし'], register: 'plain' })),
  logEncounters: vi.fn(async () => 1),
  finishStep: vi.fn(async () => {}),
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
  aiReport: mocks.aiReport,
}));
vi.mock('../../srs/output.ts', () => ({
  saveOutput: mocks.saveOutput,
  completeOutputCheck: mocks.completeOutputCheck,
  learnerAiContext: mocks.learnerAiContext,
}));
vi.mock('../../srs/encounters.ts', () => ({ logEncounters: mocks.logEncounters }));
vi.mock('../../srs/planner.ts', () => ({ finishStep: mocks.finishStep }));
vi.mock('../../srs/course.ts', () => ({ loadCourseSnapshot: async () => ({ inSprint: false }) }));
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
vi.mock('../../sync/stats.ts', () => {
  const stats = (id: string, name: string): MemberStats => ({
    member: { id, name, joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, progress: null, updatedAt: null,
  });
  const data: HouseholdResponse = {
    householdName: 'Home',
    me: 'me',
    sharedStreak: 0,
    quest: { week: '2026-10-12', minimumDays: {}, togetherSessions: 0, shortfall: 13, met: false, reserveUsed: false, reserveLeft: true, daysLeft: 4 },
    questStreakWeeks: 0,
    members: [stats('me', 'Aiko'), stats('ken', 'Ken')],
  };
  return { useHousehold: () => ({ loading: false, refresh: async () => {}, data }), pushStats: async () => true };
});
vi.mock('../../lib/data.ts', () => ({
  loadWords: async (): Promise<WordEntry[]> => [
    { id: '1', written: '水', kana: 'みず', meanings: ['water'], pos: ['n'], freqRank: 1, kanji: ['水'] },
    { id: '2', written: '飲む', kana: 'のむ', meanings: ['drink'], pos: ['v5m'], freqRank: 1, kanji: ['飲'] },
  ],
  loadWordInfo: async () => (ref: string): WordInfo | undefined => (ref === 'core:cw-0100'
    ? { ref: 'core:cw-0100', written: 'すし', kana: 'すし', en: 'sushi', kanji: [], use: true, readings: ['すし'] }
    : undefined),
}));

const ISSUE: AiIssue = { quote: '食べます', start: 8, end: 12, type: 'conjugation', uncertain: false, hint: 'Yesterday: look at the verb ending.' };
const NOTHING = { corrected: '', correctedRuby: '', diff: [], rule: '', grammarUsed: [], words: [], tips: [] };
/** Step 1: where the problem is, never the fix. */
const PROMPT: AiCheckResponse = { ok: false, issues: [ISSUE], ...NOTHING };
/** Step 2, after an edit: the fix as a diff, and the rule. */
const TIP: AiCheckResponse = {
  ok: false,
  issues: [{ ...ISSUE, hint: 'Yesterday needs the past tense.' }],
  corrected: 'きのう すしを 食べました',
  correctedRuby: 'きのう すしを {食|た}べました',
  diff: [{ op: 'same', text: 'きのう すしを 食べ' }, { op: 'del', text: 'ます' }, { op: 'ins', text: 'ました' }],
  rule: 'Yesterday needs the past tense.',
  grammarUsed: ['ta-form'],
  words: [],
  tips: [{ original: '食べます', suggestion: '', explanation: 'Yesterday needs the past tense.' }],
};
const OK = (text: string): AiCheckResponse => ({ ok: true, issues: [], ...NOTHING, corrected: text, correctedRuby: text, diff: [{ op: 'same', text }] });

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
  // Answers queued for a test that stopped early must not leak into the next one.
  mocks.aiCheck.mockReset();
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

    // Deleting can't be undone, so it asks first; Keep backs out.
    fireEvent.click(within(failed).getByRole('button', { name: 'Delete' }));
    expect(mocks.discardMessage).not.toHaveBeenCalled();
    expect(failed.textContent).toContain("Delete this message? It can't be undone.");
    expect(document.activeElement).toBe(within(failed).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(failed).getByRole('button', { name: 'Keep' }));
    expect(failed.textContent).toContain('Not sent');
    expect(document.activeElement).toBe(within(failed).getByRole('button', { name: 'Delete' }));

    fireEvent.click(within(failed).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(failed).getByRole('button', { name: 'Delete' }));
    expect(mocks.discardMessage).toHaveBeenCalledWith('p2');
  });

  it('gives the screen a heading: who the chat is with', async () => {
    renderChat();
    expect(await screen.findByRole('heading', { level: 1, name: 'Ken' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
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

  it('shows a private two-step tip: where the problem is first, the fix only after an edit', async () => {
    mocks.aiCheck.mockResolvedValueOnce(PROMPT).mockResolvedValueOnce(TIP);
    renderChat();
    await screen.findByText('いいね');
    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    await screen.findByRole('button', { name: /Stuck\?/ });

    await typeAndSend('きのう すしを 食べます');
    expect(await screen.findByText('Yesterday: look at the verb ending.')).toBeTruthy();
    expect(screen.getByText('Conjugation')).toBeTruthy();
    expect(screen.getByText(/Only you can see this tip/)).toBeTruthy();
    // The marked span, and nothing of the fix.
    expect(document.querySelector('mark.tg-issue-span')?.textContent).toContain('食べます');
    expect(document.body.textContent).not.toContain('食べました');
    expect(mocks.aiCheck).toHaveBeenCalledWith(expect.objectContaining({
      text: 'きのう すしを 食べます',
      mode: 'prompt',
      knownGrammar: ['ta-form'],
      context: ['Ken: 水を飲みます', 'Me: いいね'],
    }));
    expect(mocks.queueChatMessage).not.toHaveBeenCalled();

    // One edit of their own, then the answer.
    fireEvent.change(screen.getByLabelText('Message in Japanese'), { target: { value: 'きのう すしを 食べるでした' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Yesterday needs the past tense.')).toBeTruthy();
    expect(mocks.aiCheck).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'きのう すしを 食べるでした',
      mode: 'reveal',
      firstAttempt: 'きのう すしを 食べます',
    }));
    expect(document.querySelector('.tg-diff-ins')?.textContent).toBe('ました');

    fireEvent.click(screen.getByRole('button', { name: 'Use the fix' }));
    expect((screen.getByLabelText('Message in Japanese') as HTMLInputElement).value).toBe(TIP.corrected);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: TIP.corrected }));
    expect(mocks.aiCheck).toHaveBeenCalledTimes(2);
  });

  it('shows at most two issues', async () => {
    const three: AiCheckResponse = {
      ...PROMPT,
      issues: [ISSUE, { ...ISSUE, quote: 'すし', start: 4, end: 6, type: 'particle', hint: 'Particle one' }, { ...ISSUE, hint: 'Third' }],
    };
    mocks.aiCheck.mockResolvedValueOnce(three);
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('きのう すしを 食べます');
    await screen.findByText('Particle one');
    expect(document.querySelectorAll('.tg-issue-list li')).toHaveLength(2);
    expect(screen.queryByText('Third')).toBeNull();
  });

  it('can send it as it is, and never blocks sending', async () => {
    mocks.aiCheck.mockResolvedValue(PROMPT);
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('きのう すしを 食べます');
    fireEvent.click(await screen.findByRole('button', { name: 'Send as it is' }));
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'きのう すしを 食べます' }));
    expect(screen.queryByText(/Only you can see this tip/)).toBeNull();
  });

  it('sends offline without a check', async () => {
    mocks.status = 'offline';
    renderChat();
    await screen.findByText('いいね');
    await typeAndSend('おやすみ');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'おやすみ' }));
    expect(mocks.aiCheck).not.toHaveBeenCalled();
  });

  it('reports a tip that seems wrong', async () => {
    mocks.aiCheck.mockResolvedValueOnce(PROMPT);
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });
    await typeAndSend('きのう すしを 食べます');
    fireEvent.click(await screen.findByRole('button', { name: 'This tip seems wrong' }));
    expect(mocks.aiReport).toHaveBeenCalledWith({ kind: 'check', text: 'きのう すしを 食べます', issue: ISSUE });
    expect(screen.getByRole('button', { name: 'Thanks, noted' })).toHaveProperty('disabled', true);
  });

  describe("today's sentence", () => {
    const now = new Date().toISOString();
    beforeEach(async () => {
      await db.messages.put({ id: 3, clientId: 'c3', memberId: 'ken', createdAt: now, kind: 'text', text: '今日はラーメンを食べた', tag: 'daily' });
      await db.items.put({ id: 'core:cw-0100', kind: 'core', key: 'cw-0100', introducedAt: new Date() });
    });

    it('labels the daily sentence', async () => {
      renderChat();
      expect(await screen.findByText("Today's sentence")).toBeTruthy();
    });

    it("counts a reply to the partner's daily sentence as today's output while that step is open", async () => {
      mocks.aiCheck.mockResolvedValueOnce(OK('すしがいい'));
      renderChat();
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      expect(screen.getByText("Replying to today's sentence · counts as yours")).toBeTruthy();
      await screen.findByRole('button', { name: /Stuck\?/ });
      await typeAndSend('すしがいい');

      await waitFor(() => expect(mocks.finishStep).toHaveBeenCalledWith('output'));
      expect(mocks.aiCheck).toHaveBeenCalledWith(expect.objectContaining({ text: 'すしがいい', mode: 'prompt' }));
      expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'すしがいい', tag: 'daily' });
      expect(mocks.saveOutput).toHaveBeenCalledWith(expect.objectContaining({
        day: dayKey(),
        text: 'すしがいい',
        draft: 'すしがいい',
        chatClientId: 'client-id',
        check: 'pending',
        target: { ref: 'core:cw-0100', label: 'すし', en: 'sushi' },
      }));
      expect(mocks.saveOutput.mock.calls[0][0]).not.toHaveProperty('resultSeen');
      expect(mocks.logEncounters).toHaveBeenCalledWith(['core:cw-0100'], 'output');
      expect(await screen.findByText("That counts as today's sentence.")).toBeTruthy();
    });

    it('runs the reveal and the card guard when the reply needed a fix', async () => {
      mocks.aiCheck.mockResolvedValueOnce(PROMPT).mockResolvedValueOnce(TIP);
      renderChat();
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await screen.findByRole('button', { name: /Stuck\?/ });
      await typeAndSend('きのう すしを 食べます');
      await screen.findByText('Yesterday: look at the verb ending.');
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Use the fix' }));
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(mocks.completeOutputCheck).toHaveBeenCalledWith('out-1', TIP));
      expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: TIP.corrected, tag: 'daily' });
      // The reveal was shown here, so the next study session does not repeat it as "From earlier today".
      expect(mocks.saveOutput).toHaveBeenCalledWith(expect.objectContaining({ draft: 'きのう すしを 食べます', text: TIP.corrected, resultSeen: true }));
      expect(mocks.finishStep).toHaveBeenCalledWith('output');
    });

    it('sends a reply after the output step is done as a normal message', async () => {
      await db.days.put({ ...emptyDay(dayKey()), steps: ['output'] });
      mocks.aiCheck.mockResolvedValueOnce(OK('いいね'));
      renderChat();
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      expect(screen.getByText('Replying')).toBeTruthy();
      await screen.findByRole('button', { name: /Stuck\?/ });
      await typeAndSend('いいね');
      await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'いいね' }));
      expect(mocks.saveOutput).not.toHaveBeenCalled();
      expect(mocks.finishStep).not.toHaveBeenCalled();
    });

    it('records the output offline too, with the check pending', async () => {
      mocks.status = 'offline';
      renderChat();
      fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
      await typeAndSend('すしがいい');
      await waitFor(() => expect(mocks.finishStep).toHaveBeenCalledWith('output'));
      expect(mocks.aiCheck).not.toHaveBeenCalled();
      expect(mocks.saveOutput).toHaveBeenCalledWith(expect.objectContaining({ check: 'pending' }));
      expect(mocks.completeOutputCheck).not.toHaveBeenCalled();
    });
  });

  it('sends straight away when the helper finds nothing', async () => {
    mocks.aiCheck.mockResolvedValue(OK('おはよう'));
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
    expect(mocks.withTimeout).toHaveBeenCalledWith(expect.any(Promise), 45_000);
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
    mocks.aiCheck.mockResolvedValue(OK('うん'));
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

  it.each([
    ['ai_misconfigured', "The AI helper isn't working — check the server's AI provider and model settings."],
    // The API itself erroring isn't a setup problem: don't send anyone to check the key.
    ['ai_unavailable', "The AI helper isn't answering right now, so messages send without a check."],
  ] as const)('says once that the helper is broken (%s), then sends without checking', async (code, notice) => {
    const { ApiError } = await import('../../sync/client.ts');
    const { aiProblem } = await import('./ai.ts');
    mocks.aiCheck.mockRejectedValue(new ApiError(code === 'ai_misconfigured' ? 503 : 502, code));
    renderChat();
    await screen.findByRole('button', { name: /Stuck\?/ });

    await typeAndSend('ただいま');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'ただいま' }));
    expect((await screen.findByRole('status')).textContent).toBe(notice);
    expect(screen.queryByRole('button', { name: /Stuck\?/ })).toBeNull();
    expect(aiProblem()).toBe(code);

    // The rest of the session: no check, no waiting, and the notice isn't repeated.
    await typeAndSend('おやすみ');
    await waitFor(() => expect(mocks.queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: 'おやすみ' }));
    expect(mocks.aiCheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Checking your message/)).toBeNull();
    expect(screen.queryByText(notice)).toBeNull();
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
