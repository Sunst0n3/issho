import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DayStats,
  HouseholdResponse,
  MemberStats,
  PartnerQuizItem,
  Quiz,
  TogetherLiveState,
  TogetherState,
} from '../../../shared/api.ts';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { StoryEntry, TogetherWeekPlan } from '../../lib/types.ts';
import Together from '../../screens/Together.tsx';
import { addDays } from '../../srs/days.ts';
import type { PendingMessage } from '../../sync/outbox.ts';
import { resetQuizzes } from './quizzes.ts';
import { resetLiveInvites } from './session.ts';

const DATES = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
const day = (date: string, studyMinutes: number, patch: Partial<DayStats> = {}): DayStats => ({
  date, studyMinutes, reviews: 10, correct: 0, newItems: 0, sessionComplete: false, minimumDone: studyMinutes > 0,
  togetherMinutes: 0, restToken: false, accuracyShared: false, ...patch,
});

const member = (id: string, name: string, minutes: number[], patch: Partial<DayStats> = {}): MemberStats => ({
  member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
  days: DATES.map((d, i) => day(d, minutes[i], patch)),
  streak: 3,
  kanjiKnown: 2,
  knownKanji: ['水', '火'],
  phase: 1,
  progress: null,
  updatedAt: '2026-10-14T08:00:00Z',
});

const HOUSEHOLD: HouseholdResponse = {
  householdName: 'Home',
  me: 'me',
  sharedStreak: 4,
  quest: {
    week: '2026-10-12', minimumDays: { me: 4, ken: 5 }, togetherSessions: 2, shortfall: 2, met: false,
    reserveUsed: false, reserveLeft: true, daysLeft: 3,
  },
  questStreakWeeks: 3,
  members: [
    member('me', 'Aiko', [10, 0, 15, 20, 5, 0, 12]),
    member('ken', 'Ken', [8, 12, 0, 30, 10, 6, 0]),
  ],
};

const today = dayKey();
const PLAN: TogetherWeekPlan = {
  week: '2026-10-12',
  sessions: [
    { id: 'A', day: addDays(today, -1), time: '20:00', doneAt: addDays(today, -1), minutes: 15 },
    { id: 'B', day: today, time: '20:00' },
    { id: 'C', day: addDays(today, 2), time: '19:30' },
  ],
  settledUnit: 2,
  storyId: 'st-1',
  monthly: false,
  showcase: false,
};

const STATE: TogetherState = {
  slots: [], goal: null, stages: {}, smooth: {},
  sessions: [
    { week: '2026-10-12', session: 'A', date: '2026-10-13', minutes: 15, memberId: 'ken' },
    { week: '2026-10-12', session: 'B', date: '2026-10-14', minutes: 15, memberId: 'me' },
  ],
  tasks: [],
  checkins: [
    { week: '2026-10-05', memberId: 'me', checkin: { counts: { kanji: 3, words: 12, grammar: 1, minutes: 140 }, note: 'Good week' } },
    { week: '2026-10-05', memberId: 'ken', checkin: { counts: { kanji: 4, words: 9, grammar: 2, minutes: 120 } } },
  ],
  capstones: [],
};

const STORIES = [{ id: 'st-1', title: 'The cat next door' }] as StoryEntry[];

const PARTNER_ITEMS: PartnerQuizItem[] = [{ key: 'kanji:水|write', kind: 'write', prompt: 'Write "water"', answer: '水' }];
const quiz = (id: string, patch: Partial<Quiz>): Quiz => ({
  id, kind: 'kanji', fromMemberId: 'ken', toMemberId: 'me', createdAt: '2026-10-14T08:00:00Z',
  items: ['日', '曜', '水', '火', '木'].map((char) => ({ char })), ...patch,
});

const mocks = vi.hoisted(() => ({
  status: 'online' as 'online' | 'offline' | 'connecting',
  household: {} as { data?: HouseholdResponse; fetchedAt?: number; loading: boolean; error?: unknown },
  together: { state: null as TogetherState | null, offline: false },
  plan: undefined as TogetherWeekPlan | undefined,
  refresh: vi.fn(async () => {}),
  getQuizzes: vi.fn(),
  reconnectNow: vi.fn(),
  live: undefined as ((memberId: string, state: TogetherLiveState) => void) | undefined,
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
  reconnectNow: mocks.reconnectNow,
}));
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  getQuizzes: mocks.getQuizzes,
}));
vi.mock('../../sync/together.ts', () => ({
  useTogetherState: () => ({ ...mocks.together, refresh: async () => {} }),
  onLive: (cb: (memberId: string, state: TogetherLiveState) => void) => {
    mocks.live = cb;
    return () => {};
  },
  sendLive: () => true,
  postTogetherEvent: async () => {},
}));
vi.mock('../../srs/together.ts', () => ({
  loadWeekPlan: async () => {
    if (!mocks.plan) throw new Error('no plan');
    return mocks.plan;
  },
}));
vi.mock('../../lib/data.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/data.ts')>()),
  loadStories: async () => STORIES,
  loadUnits: async () => [{ id: 2, canDos: [{ id: 'u02-cd1', text: 'Order a drink at a café' }] }],
}));

function renderTogether() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Together /></MemoryRouter>);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetQuizzes();
  resetLiveInvites();
  mocks.status = 'online';
  mocks.household = { data: HOUSEHOLD, fetchedAt: Date.now() - 2 * 60_000, loading: false };
  mocks.together = { state: STATE, offline: false };
  mocks.plan = PLAN;
  mocks.getQuizzes.mockResolvedValue({
    inbox: [quiz('q-in', {}), quiz('q-ask', { kind: 'partner', items: PARTNER_ITEMS })],
    sent: [],
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
    expect(await screen.findByText('Practice with your partner')).toBeTruthy();
    expect(screen.getByText(/Three short sessions a week/)).toBeTruthy();
    expect(screen.getByLabelText('Household code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(mocks.getQuizzes).not.toHaveBeenCalled();
  });
});

describe('Together, paired', () => {
  beforeEach(async () => {
    await updateSettings({ name: 'Aiko', deviceToken: 'token', memberId: 'me' });
  });

  it("shows this week's sessions with their status, each opening the session", async () => {
    renderTogether();
    const week = (await screen.findByRole('heading', { name: 'This week' })).closest('section')!;
    await waitFor(() => expect(within(week).getAllByRole('link')).toHaveLength(3));
    const [a, b, c] = within(week).getAllByRole('link');
    expect(a.getAttribute('href')).toBe('/together/session/A');
    expect(a.textContent).toContain('Done');
    expect(b.textContent).toContain('Session B');
    expect(b.textContent).toContain('Today');
    expect(b.textContent).toContain('20:00');
    expect(c.textContent).toContain('Planned');
    expect(c.getAttribute('href')).toBe('/together/session/C');
  });

  it('lists the monthly session in date order with what it holds', async () => {
    mocks.plan = {
      ...PLAN,
      monthly: true,
      // The engine appends the monthly Saturday after the slots.
      sessions: [...PLAN.sessions, { id: 'monthly', day: addDays(today, 1), time: '10:00' }],
    };
    renderTogether();
    const week = (await screen.findByRole('heading', { name: 'This week' })).closest('section')!;
    await waitFor(() => expect(within(week).getAllByRole('link')).toHaveLength(4));
    const links = within(week).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/together/session/A', '/together/session/B', '/together/session/monthly', '/together/session/C',
    ]);
    expect(links[2].textContent).toContain('Monthly session · Quiz, goals & skit');
    expect(links[2].textContent).not.toContain('Monthly session · Monthly session');
  });

  it('counts together minutes in the week chart, as in the totals', async () => {
    const me = member('me', 'Aiko', [10, 0, 15, 20, 5, 0, 12]);
    me.days[6] = { ...me.days[6], studyMinutes: 0, togetherMinutes: 3 };
    mocks.household = { ...mocks.household, data: { ...HOUSEHOLD, members: [me, HOUSEHOLD.members[1]] } };
    renderTogether();
    const effort = (await screen.findByRole('heading', { name: 'Your week' })).closest('section')!;
    const row = within(effort).getAllByRole('row').find((r) => r.textContent?.startsWith('Wednesday'))!;
    expect(row.textContent).toBe('Wednesday3 min0 min');
    const stat = [...effort.querySelectorAll('dt')].find((dt) => dt.textContent?.startsWith('Minutes'))?.nextSibling?.textContent;
    expect(stat).toBe('53 · 66');
  });

  it('shows the couple quest and its streak, never the v1 shared streak', async () => {
    renderTogether();
    const quest = (await screen.findByRole('heading', { name: 'Couple quest' })).closest('section')!;
    expect(quest.textContent).toContain('You 4 of 5 days · Ken 5 of 5 days');
    expect(quest.textContent).toContain('sessions A and B done, C left · reserve available');
    expect(quest.textContent).toContain('3 days left this week.');
    expect(quest.textContent).toContain('Quest met 3 weeks running');
    expect(screen.queryByText('Shared streak')).toBeNull();
    expect(document.body.textContent).not.toContain('4 days');
  });

  it('links the shared weekly story', async () => {
    renderTogether();
    const story = await screen.findByRole('link', { name: /Read during the week: The cat next door/ });
    expect(story.getAttribute('href')).toBe('/read/st-1');
  });

  it("shows the partner's effort, and accuracy only when they share it", async () => {
    renderTogether();
    const effort = (await screen.findByRole('heading', { name: 'Your week' })).closest('section')!;
    const stat = (label: string) => [...effort.querySelectorAll('dt')].find((dt) => dt.textContent?.startsWith(label))?.nextSibling?.textContent;
    expect(stat('Days studied')).toBe('5 · 5');
    expect(stat('Minutes')).toBe('62 · 66');
    expect(within(effort).queryByText("Ken's accuracy")).toBeNull();
    cleanup();

    mocks.household = {
      ...mocks.household,
      data: { ...HOUSEHOLD, members: [HOUSEHOLD.members[0], member('ken', 'Ken', [8, 12, 0, 30, 10, 6, 0], { correct: 8, accuracyShared: true })] },
    };
    renderTogether();
    expect((await screen.findByText("Ken's accuracy")).nextSibling?.textContent).toBe('80 %');
  });

  it('lists the check-in history', async () => {
    renderTogether();
    const history = (await screen.findByRole('heading', { name: 'Check-ins' })).closest('section')!;
    expect(history.textContent).toContain('Week of 5 Oct');
    expect(history.textContent).toContain('You 3 kanji · 12 words · 1 grammar · 140 min · Good week');
    expect(history.textContent).toContain('Ken 4 kanji');
  });

  it('shows the can-do each partner ticked in the check-in history', async () => {
    mocks.together = {
      state: {
        ...STATE,
        checkins: [{ week: '2026-10-12', memberId: 'me', checkin: { counts: { kanji: 2, words: 16, grammar: 1, minutes: 75 }, canDo: 'u02-cd1' } }],
      },
      offline: false,
    };
    renderTogether();
    const history = (await screen.findByRole('heading', { name: 'Check-ins' })).closest('section')!;
    await waitFor(() => expect(history.textContent).toContain('You 2 kanji · 16 words · 1 grammar · 75 min · managed “Order a drink at a café”'));
  });

  it('offers chat, the free role-plays and the quizzes waiting for this phone', async () => {
    await db.messages.bulkPut([
      { id: 1, clientId: 'a', memberId: 'ken', createdAt: '2026-10-14T09:00:00Z', kind: 'text', text: 'おはよう' },
      { id: 2, clientId: 'b', memberId: 'ken', createdAt: '2026-10-14T09:05:00Z', kind: 'text', text: 'げんき？' },
    ]);
    localStorage.setItem('issho.chat.lastRead.v1', '1');
    renderTogether();

    const chat = await screen.findByRole('link', { name: /Chat in Japanese/ });
    expect(chat.getAttribute('href')).toBe('/chat');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Chat in Japanese げんき？ 1 unread' })).toBe(chat));
    expect(screen.getByRole('link', { name: /Free role-plays/ }).getAttribute('href')).toBe('/roleplay');

    const take = await screen.findByRole('link', { name: 'Ken sent you 5 kanji Take the quiz' });
    expect(take.getAttribute('href')).toBe('/quiz/q-in');
    const ask = screen.getByRole('link', { name: "Ken's quiz is waiting for you to ask it Open" });
    expect(ask.getAttribute('href')).toBe('/quiz/q-ask');
    // The v1 "send your hardest kanji" card is gone.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
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

  it('offers to join a session the partner just started', async () => {
    renderTogether();
    await screen.findByRole('heading', { name: 'This week' });
    act(() => mocks.live?.('ken', { sessionId: 's-1', session: 'B', opener: 'ken', step: 'task', status: 'waiting' }));
    const join = await screen.findByRole('link', { name: /Ken started Session B/ });
    expect(join.getAttribute('href')).toBe('/together/session/B');
  });

  it('makes no partner claims before the partner joins', async () => {
    mocks.household = { ...mocks.household, data: { ...HOUSEHOLD, members: [HOUSEHOLD.members[0]] } };
    renderTogether();
    expect(await screen.findByText(/Waiting for your partner to join/)).toBeTruthy();
    expect(screen.queryByText(/Ken/)).toBeNull();
  });

  it('treats the most recently active other member as the partner', async () => {
    // A leftover member who joined first (say, a test) must not hide the real partner.
    const ghost = { ...member('old', 'Test', [0, 0, 0, 0, 0, 0, 0]), updatedAt: '2026-09-02T08:00:00Z' };
    ghost.member.lastSeenAt = '2026-09-02T08:00:00Z';
    mocks.household = { ...mocks.household, data: { ...HOUSEHOLD, members: [HOUSEHOLD.members[0], ghost, HOUSEHOLD.members[1]] } };
    renderTogether();
    const effort = (await screen.findByRole('heading', { name: 'Your week' })).closest('section')!;
    expect(within(effort).getAllByRole('list')[0].textContent).toBe('YouKen');
  });

  it("says the home server can't be reached, keeps the plan, and Try again reconnects as well as refetching", async () => {
    mocks.status = 'offline';
    mocks.household = { loading: false, error: new Error('network') };
    mocks.together = { state: STATE, offline: true };
    renderTogether();
    expect(await screen.findByRole('heading', { name: "Couldn't reach your home server" })).toBeTruthy();
    expect(screen.getByText(/The couple quest and your partner's week need the home server/)).toBeTruthy();
    // The plan comes from the cached state.
    expect(await screen.findByText('From the last sync')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Session B/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.reconnectNow).toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('moves focus to the quest when Try again brings it in', async () => {
    mocks.status = 'offline';
    mocks.household = { loading: false, error: new Error('network') };
    const view = renderTogether();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    mocks.household = { data: HOUSEHOLD, fetchedAt: Date.now(), loading: false };
    view.rerender(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Together /></MemoryRouter>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Couple quest' }).closest('.tg-focus-target')));
  });

  it("says when this week's plan can't be worked out", async () => {
    mocks.plan = undefined;
    renderTogether();
    expect(await screen.findByText("This week's plan couldn't be worked out on this phone.")).toBeTruthy();
  });

  it('shows the cached view with an offline note', async () => {
    mocks.status = 'offline';
    renderTogether();
    expect(await screen.findByText('Offline — showing what we had')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Couple quest' })).toBeTruthy();
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
