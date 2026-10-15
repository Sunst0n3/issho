import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdResponse, MemberStats } from '../../../shared/api.ts';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { CourseProgressV2 } from '../../srs/course.ts';
import type { ComebackOffer, StreakV2 } from '../../srs/habits.ts';
import type { DayPlan } from '../../srs/planner.ts';
import Today from '../../screens/Today.tsx';
import { dateOfKey, mondayOf, shiftDay, WEEKDAYS_EN } from './labels.ts';
import { renderAt, resetDb } from './test-fixtures.tsx';
import { choosePrompt, type PromptInputs } from './TodayPrompts.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const state = vi.hoisted(() => ({
  plan: undefined as DayPlan | undefined,
  progress: undefined as CourseProgressV2 | undefined,
  streak: undefined as StreakV2 | undefined,
  comeback: { kind: 'none', missedDays: 0 } as ComebackOffer,
  household: undefined as HouseholdResponse | undefined,
}));

const mocks = vi.hoisted(() => ({
  spendRestToken: vi.fn(async (_date: string) => 'ok' as const),
  chooseFreshStart: vi.fn(async (_date: string) => {}),
  setTravel: vi.fn(async (_until: string | null) => {}),
  setDefaultAudioRate: vi.fn(),
}));

vi.mock('../../srs/planner.ts', () => ({ planToday: async () => state.plan }));
vi.mock('../../srs/course.ts', () => ({ courseProgress: async () => state.progress }));
vi.mock('../../srs/habits.ts', () => ({
  streak: async () => state.streak,
  comeback: async () => state.comeback,
  spendRestToken: mocks.spendRestToken,
  chooseFreshStart: mocks.chooseFreshStart,
  setTravel: mocks.setTravel,
}));
vi.mock('../../speech/audio.ts', () => ({ setDefaultAudioRate: mocks.setDefaultAudioRate }));
vi.mock('../together/TogetherTodayCard.tsx', () => ({
  TogetherTodayCard: () => <p>Together card: Session A tonight</p>,
}));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ data: state.household, fetchedAt: Date.now(), loading: false, refresh: async () => {} }),
}));

const BASE_PLAN: DayPlan = {
  day: dayKey(),
  courseDay: 20,
  mode: 'normal',
  sitting: 'any',
  budgetMin: 25,
  estimateMin: 25,
  partOfDayDone: false,
  tomorrowMin: 24,
  strandMin: 4,
  warmup: ['kanji:日|write', 'word:w-hi|read'],
  bury: [],
  teach: [{ items: [{ itemId: 'kanji:水', kind: 'kanji', key: '水', anchor: 'core:cw-0005', priceSec: 188, stream: 'kanji' }] }],
  pendingCheck: [],
  read: { kind: 'sentences', kanaWords: [], sentences: [], minutes: 3 },
  output: null,
  fluency: null,
  doneSteps: [],
  counts: { reviews: 31, newItems: 4 },
  brake: false,
  offerExtraKanji: false,
  paperAllowed: true,
  courseComplete: false,
};

const BASE_STREAK: StreakV2 = {
  current: 5,
  alive: true,
  longest: 21,
  daysThisMonth: 12,
  todayMinimum: false,
  todayGoal: false,
  tokensLeftThisWeek: 2,
  makeupOffer: false,
  week: [],
};

const PROGRESS: CourseProgressV2 = {
  courseDay: 20, sprintDone: true, kanaIntroduced: 92, kanaTotal: 92, kanjiIntroduced: 20, kanjiTotal: 2136,
  coreIntroduced: 80, grammarIntroduced: 6, unit: 2, courseComplete: false,
};

function setPlan(patch: Partial<DayPlan>) {
  state.plan = { ...BASE_PLAN, ...patch };
}
function setStreak(patch: Partial<StreakV2>) {
  state.streak = { ...BASE_STREAK, ...patch };
}

const panel = async () => (await screen.findByRole('heading', { name: "Today's plan" })).closest('section')!;

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
  await updateSettings({ onboarded: true, name: 'Sam' });
  setPlan({});
  setStreak({});
  state.progress = PROGRESS;
  state.comeback = { kind: 'none', missedDays: 0 };
  state.household = undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Today', () => {
  it('sends a new learner to the welcome screen', async () => {
    await updateSettings({ onboarded: false });
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Welcome screen')).toBeTruthy();
  });

  it('greets an onboarded learner and links to Settings', async () => {
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Sam/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
  });

  it('shows "About N min today · tomorrow about M" with the plan tiles and the ways in', async () => {
    renderAt('/', '/', <Today />);
    const plan = await panel();
    expect(plan.textContent).toContain('About 25 min today · tomorrow about 24');
    expect(plan.textContent).toContain('31reviews');
    expect(plan.textContent).toContain('4new items');
    expect(plan.textContent).toContain('3min read & listen');
    expect(within(plan).getByRole('link', { name: /Start session/ }).getAttribute('href')).toBe('/session');
    expect(within(plan).getByRole('link', { name: /3-minute session/ }).getAttribute('href')).toBe('/session?mode=micro');
    expect(mocks.setDefaultAudioRate).toHaveBeenCalledWith(20, undefined);
  });

  it('says "About N min left today" after an earlier sitting', async () => {
    setPlan({ estimateMin: 12, partOfDayDone: true });
    renderAt('/', '/', <Today />);
    expect((await panel()).textContent).toContain('About 12 min left today · tomorrow about 24');
  });

  it('says "nothing planned tomorrow" when the governor plans no minutes tomorrow (a travel day)', async () => {
    setPlan({ tomorrowMin: 0 });
    renderAt('/', '/', <Today />);
    const plan = await panel();
    expect(plan.textContent).toContain('About 25 min today · nothing planned tomorrow');
    expect(plan.textContent).not.toContain('tomorrow about 0');
  });

  it('shows no card counts in catch-up', async () => {
    setPlan({ mode: 'catch-up', counts: undefined, warmup: Array.from({ length: 140 }, (_, i) => `kanji:k${i}|write`), teach: [] });
    renderAt('/', '/', <Today />);
    const plan = await panel();
    expect(plan.textContent).toContain('About 25 min today');
    expect(plan.textContent).toContain('Reviews first today');
    expect(within(plan).queryByRole('list')).toBeNull();
    expect(plan.textContent).not.toMatch(/140|reviews due/);
  });

  it('notes the brake and offers one more kanji when the plan allows it', async () => {
    setPlan({ brake: true, offerExtraKanji: true });
    renderAt('/', '/', <Today />);
    const plan = await panel();
    expect(within(plan).getByText('New items are lighter today while reviews settle.')).toBeTruthy();
    expect(within(plan).getByRole('link', { name: /Add one more kanji today\?/ }).getAttribute('href')).toBe('/session?extra=1');
  });

  it('previews the new items: kanji with keyword', async () => {
    renderAt('/', '/', <Today />);
    const preview = (await screen.findByRole('heading', { name: 'New today' })).closest('section')!;
    await waitFor(() => expect(preview.textContent).toContain('水'));
    expect(preview.textContent).toContain('water');
  });

  it('asks to use a rest token for yesterday, and spends it on a tap', async () => {
    const yesterday = shiftDay(dayKey(), -1);
    setStreak({ offerTokenFor: yesterday, tokensLeftThisWeek: 1 });
    renderAt('/', '/', <Today />);
    const prompt = (await screen.findByRole('heading', { name: /Use a rest token for yesterday\?/ })).closest('section')!;
    fireEvent.click(within(prompt).getByRole('button', { name: 'Use a rest token' }));
    await waitFor(() => expect(mocks.spendRestToken).toHaveBeenCalledWith(yesterday));
  });

  it('puts a prompt away for the day with "Not now"', async () => {
    setStreak({ offerTokenFor: shiftDay(dayKey(), -1) });
    renderAt('/', '/', <Today />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Use a rest token/ })).toBeNull());
    cleanup();
    renderAt('/', '/', <Today />);
    await panel();
    expect(screen.queryByRole('heading', { name: /Use a rest token/ })).toBeNull();
  });

  it('offers a welcome-back warm-up while the plan panel still shows the normal plan', async () => {
    state.comeback = { kind: 'welcome-back', missedDays: 2 };
    renderAt('/', '/', <Today />);
    const card = (await screen.findByRole('heading', { name: /Welcome back — a 3-minute warm-up\?/ })).closest('section')!;
    expect(within(card).getByRole('link', { name: /Start the warm-up/ }).getAttribute('href')).toBe('/session?mode=welcome');
    expect((await panel()).textContent).toContain('About 25 min today');
    // Warm copy only: never how long the gap was.
    expect(document.body.textContent).not.toMatch(/missed|(^|\D)2 days/i);
  });

  it('offers a fresh start after a longer gap and saves the chosen date', async () => {
    state.comeback = { kind: 'fresh-start', missedDays: 4, freshStart: '2026-10-19' };
    renderAt('/', '/', <Today />);
    const button = await screen.findByRole('button', { name: /Start fresh on Monday 19 Oct/ });
    expect(screen.getByText(/catch-up first, new items after/)).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.chooseFreshStart).toHaveBeenCalledWith('2026-10-19'));
  });

  it('keeps the chosen fresh start instead of offering a later one the next day', async () => {
    await updateSettings({ freshStart: '2026-10-19' });
    state.comeback = { kind: 'fresh-start', missedDays: 5, freshStart: '2026-10-26' };
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Fresh start on Monday 19 Oct: catch-up first, new items after.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start fresh/ })).toBeNull();
  });

  it('shows the fresh-start header from Settings.freshStart, and the week dots start on that day', async () => {
    const today = dayKey();
    const before = shiftDay(today, -1);
    await updateSettings({ freshStart: today });
    setStreak({ week: [{ date: before, status: 'missed' }, { date: today, status: 'today' }] });
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('A fresh start — this week begins today')).toBeTruthy();
    const week = screen.getByRole('list', { name: 'This week' });
    expect(week.textContent).toContain('before your fresh start');
    expect(week.textContent).not.toContain('no study');
  });

  it('reads the week out as plain status text', async () => {
    const today = dayKey();
    const before = shiftDay(today, -2);
    const studied = shiftDay(today, -1);
    setStreak({ week: [{ date: before, status: 'before' }, { date: studied, status: 'done' }, { date: today, status: 'today' }] });
    renderAt('/', '/', <Today />);
    const week = await screen.findByRole('list', { name: 'This week' });
    const day = (key: string) => WEEKDAYS_EN[dateOfKey(key).getDay()];
    expect(week.textContent).toContain(`${day(before)}: before you started`);
    expect(week.textContent).toContain(`${day(studied)}: studied`);
    expect(week.textContent).toContain(`${day(today)}: today, not studied yet`);
    expect(week.textContent).not.toMatch(/not yet today|this week began/);
  });

  it('offers the make-up once the goal is met after a missed day, not the welcome-back warm-up', async () => {
    const missed = shiftDay(dayKey(), -1);
    state.comeback = { kind: 'welcome-back', missedDays: 1 };
    setStreak({ repairable: { date: missed, deadline: new Date(2026, 9, 17, 4, 0) }, makeupOffer: true, todayGoal: true, todayMinimum: true });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('link', { name: /Start the make-up/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Welcome back/ })).toBeNull();
  });

  it('stops offering the warm-up once today counts, keeping only an open fresh start', async () => {
    state.comeback = { kind: 'welcome-back', missedDays: 2 };
    setStreak({ todayMinimum: true, current: 1 });
    renderAt('/', '/', <Today />);
    await panel();
    expect(screen.queryByRole('heading', { name: /Welcome back/ })).toBeNull();
    cleanup();

    state.comeback = { kind: 'fresh-start', missedDays: 5, freshStart: '2026-10-19' };
    renderAt('/', '/', <Today />);
    const card = (await screen.findByRole('heading', { name: 'Welcome back' })).closest('section')!;
    expect(within(card).queryByRole('link', { name: /Start the warm-up/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /Start fresh on Monday 19 Oct/ })).toBeTruthy();
  });

  it("doesn't offer a rest token for yesterday after a longer gap: the welcome-back leads", async () => {
    state.comeback = { kind: 'fresh-start', missedDays: 6, freshStart: '2026-10-19' };
    setStreak({ offerTokenFor: shiftDay(dayKey(), -1), current: 0, alive: false, longest: 53 });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: /Welcome back — a 3-minute warm-up\?/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Use a rest token/ })).toBeNull();
  });

  it('shows the make-up offer only with makeupOffer, and a quiet line before the goal is met', async () => {
    const missed = shiftDay(dayKey(), -2);
    const deadline = new Date(2026, 9, 22, 4, 0);
    setStreak({ repairable: { date: missed, deadline }, makeupOffer: false });
    renderAt('/', '/', <Today />);
    expect(await screen.findByText(/make-up for .* opens after today's session/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Start the make-up/ })).toBeNull();
    cleanup();

    setStreak({ repairable: { date: missed, deadline }, makeupOffer: true, todayGoal: true, todayMinimum: true });
    renderAt('/', '/', <Today />);
    const offer = (await screen.findByRole('heading', { name: /Make up .*: 10 more minutes before Thursday 4 a\.m\. keeps your streak/ })).closest('section')!;
    expect(within(offer).getByRole('link', { name: /Start the make-up/ }).getAttribute('href')).toBe('/session?mode=makeup');
  });

  it('never renders a broken streak', async () => {
    setStreak({ current: 0, alive: false, longest: 9, daysThisMonth: 3 });
    renderAt('/', '/', <Today />);
    const card = (await screen.findByRole('heading', { name: '3 days studied this month' })).closest('section')!;
    expect(card.textContent).toContain('longest 9 days');
    expect(card.textContent).not.toMatch(/0-day|-day streak|broken|missed/);
  });

  it('shows the current streak only while it is alive', async () => {
    renderAt('/', '/', <Today />);
    const card = (await screen.findByRole('heading', { name: '12 days studied this month' })).closest('section')!;
    expect(card.textContent).toContain('longest 21 days · 5-day streak now');
  });

  it('shows the travel banner and ends travel mode', async () => {
    const until = shiftDay(dayKey(), 3);
    await updateSettings({ travelUntil: until });
    setPlan({ mode: 'travel', counts: undefined });
    renderAt('/', '/', <Today />);
    const banner = (await screen.findByRole('heading', { name: /Away until/ })).closest('section')!;
    fireEvent.click(within(banner).getByRole('button', { name: "I'm back" }));
    await waitFor(() => expect(mocks.setTravel).toHaveBeenCalledWith(null));
    expect(screen.getByRole('heading', { name: 'Travel mode' })).toBeTruthy();
  });

  it('prompts a plan review on its day and takes the day off the list when done', async () => {
    await updateSettings({ planReviewDays: [dayKey(), shiftDay(dayKey(), 28)] });
    renderAt('/', '/', <Today />);
    fireEvent.click(await screen.findByRole('button', { name: 'It still fits' }));
    await waitFor(async () => expect((await db.settings.get('me'))?.planReviewDays).toEqual([shiftDay(dayKey(), 28)]));
  });

  it('shows "Done for today" once the goal is met', async () => {
    setStreak({ todayGoal: true, todayMinimum: true });
    setPlan({ warmup: [], teach: [] });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: 'Done for today' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New today' })).toBeNull();
  });

  it('says all caught up when nothing is left', async () => {
    setPlan({ estimateMin: 0, warmup: [], teach: [], read: null, counts: { reviews: 0, newItems: 0 } });
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeTruthy();
  });

  it('shows the chapter line, linking to Learn, and never a "/ 2,136" count', async () => {
    renderAt('/', '/', <Today />);
    const line = await screen.findByRole('link', { name: /Chapter 2 · 5 of 15 done/ });
    expect(line.getAttribute('href')).toBe('/learn');
    expect(document.body.textContent).not.toMatch(/2,136|2136/);
  });

  it('shows the kana chapter during the sprint', async () => {
    state.progress = { ...PROGRESS, kanjiIntroduced: 0, kanaIntroduced: 46, sprintDone: false };
    renderAt('/', '/', <Today />);
    expect(await screen.findByRole('link', { name: /Chapter 0 · Kana · 46 of 92/ })).toBeTruthy();
  });

  it("shows the together card (it decides itself when there's a session)", async () => {
    renderAt('/', '/', <Today />);
    expect(await screen.findByText('Together card: Session A tonight')).toBeTruthy();
  });

  it('invites an unpaired phone to connect', async () => {
    renderAt('/', '/', <Today />);
    expect((await screen.findByRole('link', { name: /Study together: connect your home server/ })).getAttribute('href')).toBe('/together');
  });

  describe('partner card', () => {
    const member = (id: string, name: string, today: Partial<MemberStats['days'][number]>, progress?: Partial<NonNullable<MemberStats['progress']>>): MemberStats => ({
      member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
      days: [{ date: dayKey(), studyMinutes: 0, reviews: 0, correct: 0, newItems: 0, sessionComplete: false, ...today }],
      streak: 4,
      kanjiKnown: 80,
      knownKanji: [],
      phase: 1,
      progress: progress ? { unit: 2, chapter: 2, kanjiCanWrite: 0, kanjiCanRead: 0, wordsKnown: 0, grammarKnown: 0, hoursTotal: 0,
        daysThisMonth: 0, longestStreak: 0, readyStories: [], recentKanji: [], recentItems: [], settledUnit: 0, coreReached: 0,
        grammarReached: 0, ...progress } : null,
      updatedAt: null,
    });
    const household = (partner: MemberStats): HouseholdResponse => ({
      householdName: 'Our home',
      me: 'm-sam',
      members: [member('m-sam', 'Sam', {}), partner],
      sharedStreak: 0,
      quest: { week: '2026-10-12', minimumDays: {}, togetherSessions: 0, shortfall: 8, met: false, reserveUsed: false, reserveLeft: true, daysLeft: 4 },
      questStreakWeeks: 0,
    });

    beforeEach(async () => {
      await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    });

    it('shows effort only: minutes, together time and days this month, without accuracy', async () => {
      state.household = household(member('m-anna', 'Anna',
        { studyMinutes: 24, reviews: 31, correct: 29, newItems: 5, sessionComplete: true, minimumDone: true, togetherMinutes: 15 },
        { daysThisMonth: 11 }));
      renderAt('/', '/', <Today />);
      const card = await screen.findByRole('link', { name: /Anna met today's goal/ });
      expect(card.textContent).toContain("24 min today · 15 min together · 11 days studied this month");
      expect(card.textContent).not.toContain('%');
    });

    it("shows the partner's quest stamps this week: days studied and sessions together", async () => {
      const partner = member('m-anna', 'Anna', { studyMinutes: 20, minimumDone: true });
      state.household = {
        ...household(partner),
        quest: { ...household(partner).quest, week: mondayOf(dayKey()), minimumDays: { 'm-anna': 3, 'm-sam': 2 }, togetherSessions: 1 },
      };
      renderAt('/', '/', <Today />);
      const card = await screen.findByRole('link', { name: /Anna studied today/ });
      expect(card.textContent).toContain('This week: 3 days studied · 1 of 3 sessions together');
      expect(card.getAttribute('aria-label')).toContain('This week: 3 days studied · 1 of 3 sessions together');
    });

    it('leaves out a quest week cached before this one', async () => {
      const partner = member('m-anna', 'Anna', { studyMinutes: 20, minimumDone: true });
      state.household = {
        ...household(partner),
        quest: { ...household(partner).quest, week: shiftDay(mondayOf(dayKey()), -7), minimumDays: { 'm-anna': 5 }, togetherSessions: 3 },
      };
      renderAt('/', '/', <Today />);
      const card = await screen.findByRole('link', { name: /Anna studied today/ });
      expect(card.textContent).not.toContain('This week');
    });

    it('shows accuracy only when the partner shares it', async () => {
      state.household = household(member('m-anna', 'Anna',
        { studyMinutes: 20, reviews: 30, correct: 27, minimumDone: true, accuracyShared: true }));
      renderAt('/', '/', <Today />);
      const card = await screen.findByRole('link', { name: /Anna studied today/ });
      expect(card.textContent).toContain('90% correct');
    });
  });
});

describe('choosePrompt', () => {
  const inputs = (patch: Partial<PromptInputs> = {}, streak: Partial<StreakV2> = {}): PromptInputs => ({
    today: '2026-10-15',
    streak: { ...BASE_STREAK, ...streak },
    comeback: { kind: 'none', missedDays: 0 },
    settings: { planReviewDays: [] },
    dismissed: new Set(),
    ...patch,
  });

  it('shows at most one prompt, in the fixed order', () => {
    const all = inputs(
      {
        comeback: { kind: 'welcome-back', missedDays: 1 },
        settings: { travelUntil: '2026-10-20', planReviewDays: ['2026-10-15'] },
      },
      { offerTokenFor: '2026-10-14', makeupOffer: true, repairable: { date: '2026-10-13', deadline: new Date() } },
    );
    expect(choosePrompt(all)).toBe('rest-token');
    expect(choosePrompt({ ...all, dismissed: new Set(['rest-token']) })).toBe('comeback');
    expect(choosePrompt({ ...all, dismissed: new Set(['rest-token', 'comeback']) })).toBe('travel');
    const noTravel = { ...all, settings: { planReviewDays: ['2026-10-15'] }, dismissed: new Set(['rest-token', 'comeback'] as const) };
    expect(choosePrompt(noTravel)).toBe('plan-review');
    expect(choosePrompt({ ...noTravel, settings: { planReviewDays: ['2026-11-12'] } })).toBe('makeup');
    expect(choosePrompt(inputs())).toBeNull();
  });

  it('ignores a finished travel period and a plan review still to come', () => {
    expect(choosePrompt(inputs({ settings: { travelUntil: '2026-10-14', planReviewDays: ['2026-10-16'] } }))).toBeNull();
  });

  const repairable = { date: '2026-10-14', deadline: new Date(2026, 9, 17, 4) };

  it('offers a rest token only when it keeps the streak: yesterday is the only uncovered day', () => {
    const offer = { offerTokenFor: '2026-10-14', tokensLeftThisWeek: 2 };
    expect(choosePrompt(inputs({ comeback: { kind: 'welcome-back', missedDays: 1 } }, offer))).toBe('rest-token');
    // Two or more missed days: the run is already over, a token for yesterday would be wasted.
    expect(choosePrompt(inputs({ comeback: { kind: 'welcome-back', missedDays: 2 } }, offer))).toBe('comeback');
    expect(choosePrompt(inputs({ comeback: { kind: 'fresh-start', missedDays: 6, freshStart: '2026-10-19' } }, offer))).toBe('comeback');
  });

  it("puts the make-up ahead of the welcome-back once today's goal is met", () => {
    const met = { makeupOffer: true, repairable, todayGoal: true, todayMinimum: true };
    expect(choosePrompt(inputs({ comeback: { kind: 'welcome-back', missedDays: 1 } }, met))).toBe('makeup');
    // Before the goal the warm-up is offered (and the make-up isn't open yet).
    expect(choosePrompt(inputs({ comeback: { kind: 'welcome-back', missedDays: 1 } }, { repairable }))).toBe('comeback');
  });

  it('drops the warm-up once today counts, but keeps a fresh start on offer', () => {
    const done = { todayMinimum: true };
    expect(choosePrompt(inputs({ comeback: { kind: 'welcome-back', missedDays: 3 } }, done))).toBeNull();
    expect(choosePrompt(inputs({ comeback: { kind: 'fresh-start', missedDays: 4, freshStart: '2026-10-19' } }, done))).toBe('comeback');
  });

  it("doesn't offer a make-up that can't keep the streak (a gap long enough for a fresh start)", () => {
    const met = { makeupOffer: true, repairable, todayGoal: true, todayMinimum: true };
    const fresh = inputs({ comeback: { kind: 'fresh-start', missedDays: 4, freshStart: '2026-10-19' } }, met);
    expect(choosePrompt({ ...fresh, dismissed: new Set(['comeback']) })).toBeNull();
  });
});
