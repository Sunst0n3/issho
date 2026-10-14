import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { HouseholdResponse, MemberStats } from '../../../shared/api.ts';
import type { SessionPlan } from '../../srs/planner.ts';
import Today from '../../screens/Today.tsx';
import { addLearned, CURRICULUM, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const planner = vi.hoisted(() => ({ plan: undefined as SessionPlan | undefined }));
vi.mock('../../srs/planner.ts', () => ({
  planToday: async () => planner.plan,
}));

const household = vi.hoisted(() => ({ data: undefined as HouseholdResponse | undefined }));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ data: household.data, fetchedAt: Date.now(), loading: false, refresh: async () => {} }),
}));

const EMPTY_PLAN: SessionPlan = { reviews: [], newItems: [], reading: [], backlog: 0, estimateMinutes: 0 };

function setPlan(patch: Partial<SessionPlan>) {
  planner.plan = { ...EMPTY_PLAN, ...patch };
}

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam' });
  setPlan({});
});

afterEach(cleanup);

describe('Today', () => {
  it('sends a new learner to the welcome screen', async () => {
    await updateSettings({ onboarded: false });
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Welcome screen')).toBeTruthy();
  });

  it('greets an onboarded learner without redirecting', async () => {
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Sam/ })).toBeTruthy();
    expect(screen.queryByText('Welcome screen')).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
  });

  it("shows today's session with what's due, what's new and a start button", async () => {
    setPlan({
      reviews: ['kanji:日|meaning', 'kanji:日|reading'],
      newItems: [{ itemId: 'kanji:水', kind: 'kanji', key: '水', words: ['w-mizu'] }],
      reading: ['s-1', 's-2', 's-3'],
      backlog: 2,
      estimateMinutes: 9,
    });
    renderAt('/', '/', <Today />);
    const panel = (await screen.findByRole('heading', { name: "Today's session" })).closest('section')!;
    expect(panel.textContent).toContain('about 9 min');
    expect(panel.textContent).toContain('2reviews due');
    expect(panel.textContent).toContain('1new kanji');
    expect(panel.textContent).toContain('3sentences');
    expect(within(panel).getByRole('link', { name: /Start session/ }).getAttribute('href')).toBe('/session');

    const preview = (await screen.findByRole('heading', { name: 'New today' })).closest('section')!;
    expect(preview.textContent).toContain('水');
    expect(preview.textContent).toContain('water');
  });

  it('explains when new items are paused for a backlog', async () => {
    setPlan({
      reviews: Array.from({ length: 120 }, (_, i) => `kanji:k${i}|meaning`),
      backlog: 180,
      newBlocked: { reason: 'New items are taking a break while you catch up on 180 reviews.' },
      estimateMinutes: 24,
    });
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('New items are taking a break while you catch up on 180 reviews.')).toBeTruthy();
    expect(screen.getByText('new paused')).toBeTruthy();
    expect(screen.getByText('60 more reviews will wait for tomorrow.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New today' })).toBeNull();
  });

  it('says all caught up when nothing is due and nothing is new', async () => {
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Start session/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Practice writing/ }).getAttribute('href')).toBe('/write');
  });

  it("doesn't claim nothing is due once today's review limit is used up", async () => {
    // Every due card is a Review-state card past the daily cap: the plan has none left for today.
    setPlan({ backlog: 30 });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: "Today's reviews are done" })).toBeTruthy();
    expect(screen.getByText(/30 more reviews will wait for tomorrow/)).toBeTruthy();
    expect(screen.queryByText(/Nothing is due right now/)).toBeNull();
  });

  it('sends a first-time visitor (no settings saved yet) to the welcome screen', async () => {
    await db.settings.clear();
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Welcome screen')).toBeTruthy();
  });

  it('celebrates a finished course', async () => {
    for (const u of CURRICULUM.units) await addLearned(u.type, u.char);
    setPlan({ courseComplete: true });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: "You've met every kanji" })).toBeTruthy();
  });

  it("doesn't call the course finished while new words or grammar are still to come", async () => {
    for (const u of CURRICULUM.units) await addLearned(u.type, u.char);
    setPlan({ courseComplete: false });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "You've met every kanji" })).toBeNull();
  });

  it('shows "Done for today" with extra practice once the session is complete', async () => {
    await db.days.put({ date: dayKey(), studyMs: 600_000, reviews: 20, correct: 18, newItems: 5, sessionComplete: true });
    setPlan({ newItems: [{ itemId: 'kanji:火', kind: 'kanji', key: '火' }], estimateMinutes: 2 });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: 'Done for today' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Practice writing/ }).getAttribute('href')).toBe('/write');
    expect(screen.getByRole('link', { name: /Read & shadow/ }).getAttribute('href')).toBe('/read');
    expect(screen.getByRole('heading', { name: '1-day streak' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New today' })).toBeNull();
    expect(screen.getByText('Nice work. Your next reviews will be waiting tomorrow.')).toBeTruthy();
  });

  it("doesn't promise tomorrow's reviews while extra reviews are ready", async () => {
    await db.days.put({ date: dayKey(), studyMs: 600_000, reviews: 20, correct: 18, newItems: 5, sessionComplete: true });
    setPlan({ reviews: ['kanji:日|meaning', 'kanji:日|reading'], estimateMinutes: 2 });
    renderAt('/', '/', <Today />);
    const panel = (await screen.findByRole('heading', { name: 'Done for today' })).closest('section')!;
    expect(panel.textContent).not.toContain('waiting tomorrow');
    expect(within(panel).getByRole('link', { name: /2 more reviews ready/ }).getAttribute('href')).toBe('/session');
  });

  it("doesn't call the course over while reviews wait for tomorrow", async () => {
    for (const u of CURRICULUM.units) await addLearned(u.type, u.char);
    setPlan({ backlog: 200, courseComplete: true });
    renderAt('/', '/', <Today />);
    const panel = (await screen.findByRole('heading', { name: "You've met every kanji" })).closest('section')!;
    expect(panel.textContent).not.toContain("That's the whole course");
    expect(panel.textContent).toContain('200 more reviews will wait for tomorrow.');
  });

  it('keeps the break note away from a finished course: held-back new items mean it is not finished', async () => {
    for (const u of CURRICULUM.units) await addLearned(u.type, u.char);
    const reason = 'New items are taking a break while you catch up on 200 reviews.';
    setPlan({ backlog: 200, newBlocked: { reason }, courseComplete: false });
    renderAt('/', '/', <Today />);
    const panel = (await screen.findByRole('heading', { name: "Today's reviews are done" })).closest('section')!;
    expect(panel.textContent).toContain(reason);
    expect(screen.queryByRole('heading', { name: "You've met every kanji" })).toBeNull();
  });

  it('shows the days before the learner started as not started, not missed', async () => {
    // A Wednesday evening, onboarded today with both kana marked known.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 20, 0));
    try {
      await db.items.add({ id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: new Date() });
      renderAt('/', '/', <Today />);
      const week = await screen.findByRole('list', { name: 'This week' });
      expect(week.textContent).toContain('Monday: before you started');
      expect(week.textContent).toContain('Tuesday: before you started');
      expect(week.textContent).toContain('Wednesday: today, not done yet');
      expect(week.textContent).not.toContain('missed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('invites an unpaired phone to connect, and shows the phase progress', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await addLearned('kanji', '日');
    renderAt('/', '/', <Today />);
    expect((await screen.findByRole('link', { name: /Study together: connect your home server/ })).getAttribute('href')).toBe('/together');
    expect((await screen.findByRole('link', { name: /Phase 2 · 1 of 5 kanji/ })).getAttribute('href')).toBe('/learn');
    expect(screen.getByText('Works offline · progress saved on this phone')).toBeTruthy();
  });

  it("warns on an insecure (http://) address and doesn't promise offline use there", async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    try {
      renderAt('/', '/', <Today />);
      expect(await screen.findByRole('heading', { name: "Issho can't work offline from this address" })).toBeTruthy();
      expect(screen.getByText('Progress saved on this phone')).toBeTruthy();
      expect(screen.queryByText(/Works offline/)).toBeNull();
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    }
    cleanup();
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Works offline · progress saved on this phone')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /can't work offline/ })).toBeNull();
  });

  it('says so when the home server removed this phone', async () => {
    localStorage.setItem('issho.sync.removed', '1');
    try {
      renderAt('/', '/', <Today />);
      expect((await screen.findByRole('link', { name: /This phone was disconnected: connect again/ })).getAttribute('href')).toBe('/together');
    } finally {
      localStorage.removeItem('issho.sync.removed');
    }
  });

  it("shows how the partner's day went on a paired phone", async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    const member = (id: string, name: string, today: Partial<MemberStats['days'][number]>): MemberStats => ({
      member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
      days: [{ date: dayKey(), studyMinutes: 12, reviews: 0, correct: 0, newItems: 0, sessionComplete: false, ...today }],
      streak: 4,
      kanjiKnown: 80,
      knownKanji: [],
      phase: 2,
      updatedAt: null,
    });
    household.data = {
      householdName: 'Our home',
      me: 'm-sam',
      members: [member('m-sam', 'Sam', {}), member('m-anna', 'Anna', { reviews: 31, correct: 29, newItems: 5, sessionComplete: true })],
      sharedStreak: 3,
    };
    renderAt('/', '/', <Today />);
    const card = await screen.findByRole('link', { name: /Anna finished today/ });
    expect(card.getAttribute('href')).toBe('/together');
    expect(card.textContent).toContain('5 new · 31 reviews · 94% correct');
    // The lines of the card are separated in its accessible name.
    expect(card.getAttribute('aria-label')).toBe('Anna finished today. 5 new · 31 reviews · 94% correct');
    expect(screen.queryByText(/connect your home server/)).toBeNull();
    household.data = undefined;
  });

  it('shows the partner seen most recently, not a leftover member who joined first', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    const member = (id: string, name: string, updatedAt: string | null): MemberStats => ({
      member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
      days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 2, updatedAt,
    });
    household.data = {
      householdName: 'Our home',
      me: 'm-sam',
      members: [member('m-ghost', 'Anna (old phone)', '2026-09-02T00:00:00Z'), member('m-sam', 'Sam', null),
        member('m-anna', 'Anna', '2026-10-13T00:00:00Z')],
      sharedStreak: 0,
    };
    try {
      renderAt('/', '/', <Today />);
      expect(await screen.findByRole('link', { name: /^Anna hasn't studied yet today/ })).toBeTruthy();
      expect(screen.queryByText(/old phone/)).toBeNull();
    } finally {
      household.data = undefined;
    }
  });

  it("words the partner's streak as an n-day streak", async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam' });
    const member = (id: string, name: string, streak: number): MemberStats => ({
      member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
      days: [],
      streak,
      kanjiKnown: 0,
      knownKanji: [],
      phase: 2,
      updatedAt: null,
    });
    household.data = { householdName: 'Our home', me: 'm-sam', members: [member('m-sam', 'Sam', 0), member('m-anna', 'Anna', 4)], sharedStreak: 0 };
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('4-day streak so far')).toBeTruthy();
    household.data = undefined;
  });
});
