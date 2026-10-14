import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayStats, HouseholdResponse, MemberStats, Quiz } from '../../../shared/api.ts';
import { db, updateSettings } from '../../lib/db.ts';
import type { RolePlay } from '../../lib/types.ts';
import Together from '../../screens/Together.tsx';
import type { PendingMessage } from '../../sync/outbox.ts';
import { resetQuizzes } from './quizzes.ts';

const day = (date: string, studyMinutes: number): DayStats => ({
  date, studyMinutes, reviews: 0, correct: 0, newItems: 0, sessionComplete: studyMinutes > 0,
});
const DATES = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];

const member = (id: string, name: string, minutes: number[], knownKanji: string[]): MemberStats => ({
  member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
  days: DATES.map((d, i) => day(d, minutes[i])),
  streak: 3,
  kanjiKnown: knownKanji.length,
  knownKanji,
  phase: 2,
  updatedAt: '2026-10-14T08:00:00Z',
});

const HOUSEHOLD: HouseholdResponse = {
  householdName: 'Home',
  me: 'me',
  sharedStreak: 4,
  members: [
    member('me', 'Aiko', [10, 0, 15, 20, 5, 0, 12], ['水', '火']),
    member('ken', 'Ken', [8, 12, 0, 30, 10, 6, 0], ['水', '木', '金']),
  ],
};

const quiz = (id: string, patch: Partial<Quiz>): Quiz => ({
  id, fromMemberId: 'ken', toMemberId: 'me', createdAt: '2026-10-14T08:00:00Z',
  items: ['日', '曜', '水', '火', '木'].map((char) => ({ char })), ...patch,
});

const SCRIPTS: RolePlay[] = [
  { id: 'rp-1', title: 'Good morning', titleJp: 'おはよう', level: 1, setting: 'Morning.', roles: { a: { name: 'A', nameJp: 'え' }, b: { name: 'B', nameJp: 'び' } }, lines: [] },
  { id: 'rp-2', title: 'At the station', titleJp: '{駅|えき}で', level: 2, setting: 'Buying a ticket.', roles: { a: { name: 'A', nameJp: 'え' }, b: { name: 'B', nameJp: 'び' } }, lines: [] },
];

const mocks = vi.hoisted(() => ({
  status: 'online' as 'online' | 'offline' | 'connecting',
  household: {} as { data?: HouseholdResponse; fetchedAt?: number; loading: boolean; error?: unknown },
  refresh: vi.fn(async () => {}),
  getQuizzes: vi.fn(),
  createQuiz: vi.fn(),
  hardestKanji: vi.fn(),
}));

vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ ...mocks.household, refresh: mocks.refresh }),
  pushStats: async () => true,
}));
vi.mock('../../sync/socket.ts', () => ({
  useServerStatus: () => mocks.status,
  onServerEvent: () => () => {},
  onStatusChange: () => () => {},
  connectFromSettings: async () => {},
}));
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  getQuizzes: mocks.getQuizzes,
  createQuiz: mocks.createQuiz,
}));
vi.mock('../../srs/course.ts', () => ({ currentPhase: async () => 2 }));
vi.mock('../../srs/progress.ts', () => ({ hardestKanji: mocks.hardestKanji }));
vi.mock('../../lib/data.ts', () => ({ loadRolePlays: async () => SCRIPTS }));

function renderTogether() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Together /></MemoryRouter>);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetQuizzes();
  mocks.status = 'online';
  mocks.household = { data: HOUSEHOLD, fetchedAt: Date.now() - 2 * 60_000, loading: false };
  mocks.getQuizzes.mockResolvedValue({
    inbox: [quiz('q-in', {})],
    sent: [quiz('q-out', {
      fromMemberId: 'me', toMemberId: 'ken',
      result: { correct: 3, total: 4, missed: ['曜'], finishedAt: '2026-10-14T09:00:00Z' },
    })],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Together, not paired', () => {
  it('explains the together features and offers to connect', async () => {
    await updateSettings({ name: 'Aiko' });
    renderTogether();
    expect(await screen.findByText('Practise with your partner')).toBeTruthy();
    expect(screen.getByLabelText('Household code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(mocks.getQuizzes).not.toHaveBeenCalled();
  });
});

describe('Together, paired', () => {
  beforeEach(async () => {
    await updateSettings({ name: 'Aiko', deviceToken: 'token', memberId: 'me' });
    await db.items.bulkPut([
      { id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() },
      { id: 'kanji:火', kind: 'kanji', key: '火', introducedAt: new Date() },
    ]);
  });

  it('shows both weeks side by side with shared stats', async () => {
    renderTogether();
    expect(await screen.findByText('This week')).toBeTruthy();
    expect(screen.getByText('Synced 2 min ago')).toBeTruthy();

    // The table behind the bars, labelled by the server's dates.
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('Thursday');
    expect(rows[4].textContent).toContain('20 min');
    expect(rows[4].textContent).toContain('30 min');

    const stats = screen.getByText('Shared streak').closest('dl')!;
    expect(stats.textContent).toContain('4 days');
    expect(within(stats).getByText('You both know').nextSibling?.textContent).toBe('1');
    expect(stats.textContent).toContain('2 · 3');
  });

  it("offers chat, tonight's role-play and the quizzes", async () => {
    await db.messages.bulkPut([
      { id: 1, clientId: 'a', memberId: 'ken', createdAt: '2026-10-14T09:00:00Z', kind: 'text', text: 'おはよう' },
      { id: 2, clientId: 'b', memberId: 'ken', createdAt: '2026-10-14T09:05:00Z', kind: 'text', text: 'げんき？' },
    ]);
    localStorage.setItem('issho.chat.lastRead.v1', '1');
    renderTogether();

    const chat = await screen.findByRole('link', { name: /Chat in Japanese/ });
    expect(chat.getAttribute('href')).toBe('/chat');
    await waitFor(() => expect(chat.textContent).toContain('げんき？'));
    expect(chat.textContent).toContain('1 unread');

    // Phase 2 → a level 2 script.
    expect(await screen.findByText('At the station')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Start role-play/ }).getAttribute('href')).toBe('/roleplay/rp-2');

    const take = await screen.findByRole('link', { name: /Take the quiz/ });
    expect(take.getAttribute('href')).toBe('/quiz/q-in');
    expect(take.textContent).toContain('Ken sent you 5 kanji');
    const sent = screen.getByText(/Ken got 3\/4/);
    expect(sent.textContent).toContain('missed 曜');
    expect(sent.textContent).toContain('1 new to them');
  });

  it("doesn't call a rejected message one that is waiting to send", async () => {
    await db.outbox.bulkPut([
      { clientId: 'p1', createdAt: new Date(), kind: 'text', text: 'まだ', attempts: 0 },
      { clientId: 'p2', createdAt: new Date(), kind: 'text', text: 'だめ', attempts: 1, failed: 'too_large' } as PendingMessage,
    ]);
    renderTogether();
    const chat = await screen.findByRole('link', { name: /Chat in Japanese/ });
    await waitFor(() => expect(chat.textContent).toContain('1 not sent · open the chat to retry'));

    await db.outbox.delete('p2');
    await waitFor(() => expect(chat.textContent).toContain('1 waiting to send'));
  });

  it('sends the hardest kanji after confirming them', async () => {
    mocks.hardestKanji.mockResolvedValue([{ char: '曜', lapses: 3, stability: 1 }, { char: '週', lapses: 2, stability: 2 }]);
    mocks.createQuiz.mockImplementation(async (req) => ({ ...quiz('q-new', {}), fromMemberId: 'me', toMemberId: 'ken', items: req.items }));
    renderTogether();

    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const list = await screen.findByRole('list', { name: 'Kanji in the quiz' });
    expect(list.textContent).toBe('曜週');
    expect(screen.getByText('Send these 2 kanji to Ken?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send quiz' }));

    expect(await screen.findByText(/Sent to Ken/)).toBeTruthy();
    expect(mocks.createQuiz).toHaveBeenCalledWith({ toMemberId: 'ken', items: [{ char: '曜' }, { char: '週' }] });
  });

  it('makes no shared claims before the partner joins', async () => {
    mocks.household = { ...mocks.household, data: { ...HOUSEHOLD, sharedStreak: 3, members: [HOUSEHOLD.members[0]] } };
    renderTogether();
    expect(await screen.findByText(/Waiting for your partner to join/)).toBeTruthy();
    const stats = screen.getByText('Shared streak').closest('dl')!;
    expect(within(stats).getByText('Shared streak').nextSibling?.textContent).toBe('–');
    expect(within(stats).getByText('You both know').nextSibling?.textContent).toBe('–');
    expect(screen.getByText('Once your partner joins, you can send them the kanji you miss most.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
  });

  it('treats the most recently active other member as the partner', async () => {
    // A leftover member who joined first (say, a test) must not hide the real partner.
    const ghost = { ...member('old', 'Test', [0, 0, 0, 0, 0, 0, 0], []), updatedAt: '2026-09-02T08:00:00Z' };
    ghost.member.lastSeenAt = '2026-09-02T08:00:00Z';
    mocks.household = { ...mocks.household, data: { ...HOUSEHOLD, members: [HOUSEHOLD.members[0], ghost, HOUSEHOLD.members[1]] } };
    mocks.hardestKanji.mockResolvedValue([{ char: '曜', lapses: 3, stability: 1 }]);
    mocks.createQuiz.mockImplementation(async (req) => ({ ...quiz('q-new', {}), fromMemberId: 'me', toMemberId: req.toMemberId, items: req.items }));
    renderTogether();

    const legend = (await screen.findByText('This week')).closest('section')!;
    expect(within(legend).getByRole('list').textContent).toBe('YouKen');
    expect(screen.getByText('Send Ken the 5 kanji you miss most.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send quiz' }));
    await waitFor(() => expect(mocks.createQuiz).toHaveBeenCalledWith({ toMemberId: 'ken', items: [{ char: '曜' }] }));
  });

  it('shows the cached view with an offline note', async () => {
    mocks.status = 'offline';
    renderTogether();
    expect(await screen.findByText('Offline — showing what we had')).toBeTruthy();
    expect(screen.getByText('This week')).toBeTruthy();
  });

  it('asks to reconnect when this phone was removed', async () => {
    // What the client leaves behind after a 401 'unauthorized' (see forgetRevokedPairing).
    localStorage.setItem('issho.sync.removed', '1');
    await updateSettings({ deviceToken: undefined, memberId: undefined });
    renderTogether();
    expect(await screen.findByText('This phone was disconnected.')).toBeTruthy();
    expect(screen.getByLabelText('Household code')).toBeTruthy();
  });
});
