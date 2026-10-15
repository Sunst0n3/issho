import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createEmptyCard, Rating, State, type Grade } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import type { CardRecord, CardType, ItemKind, ItemRecord } from '../../lib/types.ts';
import type { IntroduceResult } from '../../srs/items.ts';
import Session from '../../screens/Session.tsx';
import { introducePlanItem, type NewItemPlan } from '../../srs/course.ts';
import { completeDay, completeMakeup, streak, type StreakV2 } from '../../srs/habits.ts';
import { finishStep, planMakeup, planToday, startSitting, type DayPlan } from '../../srs/planner.ts';
import { gradeCard, type GradeOptions } from '../../srs/scheduler.ts';
import { pushStats } from '../../sync/stats.ts';
import { KANA, resetStudyDb, WORDS } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);
vi.mock('../../speech/recognition.ts', () => ({ recognitionAvailable: () => false, listen: vi.fn() }));
vi.mock('../../speech/recorder.ts', () => ({ micAvailable: () => false }));
vi.mock('../../sync/stats.ts', () => ({ pushStats: vi.fn(async () => true), useHousehold: () => ({ loading: false, refresh: async () => {} }) }));
vi.mock('../../sync/outbox.ts', () => ({ queueChatMessage: vi.fn(async () => 'client-1') }));
vi.mock('../../sync/client.ts', async (original) => {
  const real = await original<typeof import('../../sync/client.ts')>();
  return { ...real, aiCheck: vi.fn(async () => { throw new real.ApiError(503, 'ai_disabled'); }), aiReport: vi.fn() };
});
vi.mock('../../srs/output.ts', () => ({
  learnerAiContext: vi.fn(async () => ({})),
  saveOutput: vi.fn(async (rec: object) => ({ ...rec, id: 'out-1', createdAt: new Date() })),
  completeOutputCheck: vi.fn(async () => ({})),
}));
vi.mock('../../srs/planner.ts', () => ({
  planToday: vi.fn(),
  planMicro: vi.fn(),
  planMakeup: vi.fn(),
  startSitting: vi.fn(async () => {}),
  finishStep: vi.fn(async () => {}),
  leakMask: vi.fn(async () => ({ readings: new Set(), meanings: new Set(), kanji: new Set() })),
}));
vi.mock('../../srs/habits.ts', () => ({
  completeDay: vi.fn(),
  completeMicro: vi.fn(async () => {}),
  completeMakeup: vi.fn(async () => false),
  streak: vi.fn(),
  noteReviewProgress: vi.fn(async () => true),
}));
vi.mock('../../srs/course.ts', async (original) => ({
  ...(await original<typeof import('../../srs/course.ts')>()),
  introducePlanItem: vi.fn(),
  currentUnit: vi.fn(async () => 1),
  taughtKana: vi.fn(async () => new Set<string>()),
  loadCourseSnapshot: vi.fn(async () => ({ courseDay: 20, inSprint: false, kana: KANA })),
}));
vi.mock('../../srs/progress.ts', async (original) => ({
  ...(await original<typeof import('../../srs/progress.ts')>()),
  learnedToday: vi.fn(async () => []),
  retention: vi.fn(async () => []),
  addStudyTime: vi.fn(async () => {}),
}));
vi.mock('../../srs/scheduler.ts', async (original) => ({
  ...(await original<typeof import('../../srs/scheduler.ts')>()),
  gradeCard: vi.fn(async (id: string) => ({ id, due: new Date(Date.now() + 86_400_000) })),
}));

const DAY = 86_400_000;
const STREAK: StreakV2 = {
  current: 3, alive: true, longest: 5, daysThisMonth: 6, todayMinimum: true, todayGoal: true, tokensLeftThisWeek: 2,
  makeupOffer: false, week: [],
};

function newCard(itemId: string, kind: ItemKind, type: CardType): CardRecord {
  return { ...createEmptyCard(new Date()), id: cardId(itemId, type), itemId, kind, type };
}

/** A Review-state card due an hour ago. */
function dueCard(itemId: string, kind: ItemKind, type: CardType): CardRecord {
  const past = new Date(Date.now() - 3 * DAY);
  return { ...createEmptyCard(past), state: State.Review, reps: 3, stability: 8, last_review: past, due: new Date(Date.now() - 3600_000),
    id: cardId(itemId, type), itemId, kind, type };
}

async function seedWords(...ids: string[]) {
  const items: ItemRecord[] = ids.map((id) => ({ id: `word:${id}`, kind: 'word', key: id, introducedAt: new Date(Date.now() - 10 * DAY) }));
  await db.items.bulkPut(items);
  await db.cards.bulkPut(ids.map((id) => dueCard(`word:${id}`, 'word', 'read')));
}

const kanjiPlan = (char: string, anchor: string): NewItemPlan =>
  ({ itemId: `kanji:${char}`, kind: 'kanji', key: char, anchor: `word:${anchor}`, priceSec: 188, stream: 'kanji' });

function plan(over: Partial<DayPlan> = {}): DayPlan {
  return {
    day: '2026-10-15', courseDay: 20, mode: 'normal', sitting: 'any', budgetMin: 25, estimateMin: 20, partOfDayDone: false,
    tomorrowMin: 18, strandMin: 4, warmup: [], bury: [], teach: [], pendingCheck: [], read: null, output: null, fluency: null,
    doneSteps: [], counts: { reviews: 0, newItems: 0 }, brake: false, offerExtraKanji: false, paperAllowed: true, courseComplete: false,
    ...over,
  };
}

/** introducePlanItem: the item, its anchor and their New cards, stored. */
async function fakeIntroduce(p: NewItemPlan) {
  const now = new Date();
  const results: IntroduceResult[] = [];
  const add = async (id: string, kind: ItemKind, types: CardType[]) => {
    const item: ItemRecord = { id, kind, key: id.slice(kind.length + 1), introducedAt: now };
    const cards = types.map((t) => newCard(id, kind, t));
    await db.items.put(item);
    await db.cards.bulkPut(cards);
    results.push({ item, cards, created: true });
  };
  if (p.kind === 'kanji') {
    await add(p.itemId, 'kanji', ['write']);
    if (p.anchor) await add(p.anchor, 'word', ['read']);
  } else if (p.kind === 'core') {
    await add(p.itemId, 'core', ['listen']);
  }
  return results;
}

function renderSession(path = '/session', strict = false) {
  const tree = (
    <MemoryRouter initialEntries={['/', path]} initialIndex={1} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/session" element={<Session />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const counter = () => document.querySelector('.st-count')?.textContent ?? '';
const reading = (written: string) => WORDS.find((w) => w.written === written)!.kana;

/** Answers the word-read card on screen: right (Good), or wrong twice and "No" (Again, with its feedback). */
async function answerWordRead(right: boolean): Promise<string> {
  const target = await screen.findByText((_, el) => Boolean(el?.matches('.st-target, .st-big.st-fit')));
  const written = target.textContent ?? '';
  const input = screen.getByLabelText('Reading');
  if (right) {
    fireEvent.change(input, { target: { value: reading(written) } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
  } else {
    fireEvent.change(input, { target: { value: 'zz' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  }
  await waitFor(() => expect(screen.queryByText(written, { selector: '.st-target, .st-big.st-fit' })).toBeNull());
  return written;
}

const gradeCalls = () => vi.mocked(gradeCard).mock.calls.map(([id, grade, opts]) => ({ id, grade: grade as Grade, context: (opts as GradeOptions).context }));

beforeEach(async () => {
  await resetStudyDb();
  vi.mocked(planToday).mockReset();
  vi.mocked(planMakeup).mockReset();
  vi.mocked(completeMakeup).mockClear();
  vi.mocked(startSitting).mockClear();
  vi.mocked(finishStep).mockClear();
  vi.mocked(gradeCard).mockClear();
  vi.mocked(pushStats).mockClear();
  vi.mocked(completeDay).mockReset().mockResolvedValue(STREAK);
  vi.mocked(streak).mockReset().mockResolvedValue(STREAK);
  vi.mocked(introducePlanItem).mockReset().mockImplementation(fakeIntroduce);
});

afterEach(() => {
  cleanup();
});

describe('Session', () => {
  it('runs warm-up → teach → memory → read → check → output → fluency → summary, recording only the once-a-day steps', async () => {
    await seedWords('w-ike');
    vi.mocked(planToday).mockResolvedValue(plan({
      warmup: ['word:w-ike|read'],
      teach: [{ items: [kanjiPlan('水', 'w-mizu')] }],
      read: { kind: 'sentences', kanaWords: [], sentences: [{ id: 's-mizu', target: 'word:w-mizu' }], minutes: 3 },
      output: { target: { ref: 'core:cw-0003', label: 'もう', en: 'already' } },
      fluency: { kind: 'speed', cardIds: ['nope|read'] },
      counts: { reviews: 1, newItems: 1 },
    }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));

    // Warm-up.
    await screen.findByLabelText('Reading');
    expect(counter()).toBe('Warm-up 1 / 1');
    await answerWordRead(true);

    // Teach: the kanji lesson, then a guided copy.
    expect(await screen.findByRole('heading', { name: 'water' })).toBeTruthy();
    expect(counter()).toBe('New');
    fireEvent.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(screen.getByRole('img', { name: /guided/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Memory pass.
    expect(await screen.findByText('From memory 1 / 1')).toBeTruthy();
    expect(counter()).toBe('Memory');
    expect(screen.getByText('Spaced recalls feel harder — that is why they stick.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write it right' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    // Read & listen.
    expect(await screen.findByRole('heading', { name: 'Read it aloud first' })).toBeTruthy();
    expect(counter()).toBe('Read');
    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'What does it mean?' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'What does it mean?' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Answer choices' })).getAllByRole('button')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    // First check: production first (the write card), then the anchor's read card.
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(counter()).toBe('Check 1 / 2');
    expect(screen.getByText('Spaced recalls feel harder — that is why they stick.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write it right' }));
    fireEvent.click(await screen.findByText('Correct'));
    await answerWordRead(true);

    // Today's sentence (no AI here: it is sent as it is).
    fireEvent.change(await screen.findByLabelText('Your sentence'), { target: { value: 'もうたべました' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    fireEvent.click(await screen.findByRole('button', { name: /Send to your partner/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    // Fluency, then the summary.
    expect(await screen.findByText('No speed round today.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Done for now' })).toBeTruthy();
    expect(await screen.findByText('about 18 min')).toBeTruthy();

    await waitFor(() => expect(completeDay).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pushStats).toHaveBeenCalledWith({ immediate: true }));
    expect(vi.mocked(finishStep).mock.calls.map(([s]) => s)).toEqual(['read', 'output', 'fluency']);
    expect(gradeCalls()).toEqual([
      { id: 'word:w-ike|read', grade: Rating.Good, context: 'review' },
      { id: 'kanji:水|write', grade: Rating.Good, context: 'first-check' },
      { id: 'word:w-mizu|read', grade: Rating.Good, context: 'first-check' },
    ]);
  });

  it('runs the memory pass for a batch only after its last item’s guided copy', async () => {
    vi.mocked(planToday).mockResolvedValue(plan({
      teach: [{ items: [kanjiPlan('水', 'w-mizu'), kanjiPlan('日', 'w-nihon'), kanjiPlan('木', 'w-ki'), kanjiPlan('人', 'w-hito')] }],
    }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    for (const meaning of ['water', 'day', 'tree', 'person']) {
      expect(await screen.findByRole('heading', { name: meaning })).toBeTruthy();
      expect(screen.queryByText(/From memory/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Copy it' }));
      fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
      expect(screen.queryByText(/From memory/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    }
    expect(await screen.findByText('From memory 1 / 4')).toBeTruthy();
    expect(introducePlanItem).toHaveBeenCalledTimes(4);
  });

  it('re-asks a missed warm-up card after at least 5 others, graded again as a re-ask', async () => {
    const ids = ['w-mizu', 'w-sui', 'w-nihon', 'w-hon', 'w-ki', 'w-hito', 'w-ike'];
    await seedWords(...ids);
    vi.mocked(planToday).mockResolvedValue(plan({ warmup: ids.map((id) => `word:${id}|read`), counts: { reviews: 7, newItems: 0 } }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    await screen.findByLabelText('Reading');
    const order = [await answerWordRead(false)];
    for (let i = 0; i < 7; i++) order.push(await answerWordRead(true));
    // The missed word comes back as the 7th card: 5 others in between.
    expect(order.indexOf(order[0], 1)).toBe(6);
    await screen.findByRole('heading', { name: 'Done for now' });
    const calls = gradeCalls().filter((c) => c.id === `word:${ids[0]}|read`);
    expect(calls).toEqual([
      { id: 'word:w-mizu|read', grade: Rating.Again, context: 'review' },
      { id: 'word:w-mizu|read', grade: Rating.Good, context: 're-ask' },
    ]);
    expect(gradeCalls()).toHaveLength(8);
  });

  it('re-asks a first-check miss once, graded in the first check, and never retrieves a new card more than 4 times', async () => {
    await db.items.put({ id: 'word:w-ike', kind: 'word', key: 'w-ike', introducedAt: new Date() });
    await db.cards.put(newCard('word:w-ike', 'word', 'read'));
    vi.mocked(planToday).mockResolvedValue(plan({ pendingCheck: ['word:w-ike|read'] }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    await screen.findByLabelText('Reading');
    await answerWordRead(false);
    // The re-ask, missed again: not asked a third time.
    await screen.findByText('Once more, from earlier');
    await answerWordRead(false);
    await screen.findByRole('heading', { name: 'Done for now' });
    expect(gradeCalls()).toEqual([
      { id: 'word:w-ike|read', grade: Rating.Again, context: 'first-check' },
      { id: 'word:w-ike|read', grade: Rating.Again, context: 'first-check' },
    ]);
  });

  it('plans again every time it opens', async () => {
    vi.mocked(planToday).mockResolvedValue(plan({ teach: [{ items: [kanjiPlan('水', 'w-mizu')] }] }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /At my desk/ }));
    await screen.findByRole('heading', { name: 'water' });
    expect(planToday).toHaveBeenCalledWith(expect.any(Date), { sitting: 'desk' });
    cleanup();
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    await screen.findByRole('heading', { name: 'water' });
    expect(planToday).toHaveBeenCalledTimes(2);
  });

  it('runs start-up and introduction side effects once under StrictMode and double taps', async () => {
    vi.mocked(planToday).mockResolvedValue(plan({
      teach: [{ items: [{ itemId: 'core:cw-0003', kind: 'core', key: 'cw-0003', priceSec: 35, stream: 'core' }] }],
    }));
    renderSession('/session', true);
    const choice = await screen.findByRole('button', { name: /All of it/ });
    fireEvent.click(choice);
    fireEvent.click(choice);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the word' }));
    const gotIt = screen.getByRole('button', { name: 'Got it' });
    await act(async () => {
      fireEvent.click(gotIt);
      fireEvent.click(gotIt);
    });
    expect(await screen.findByText('From memory 1 / 1')).toBeTruthy();
    expect(planToday).toHaveBeenCalledTimes(1);
    expect(startSitting).toHaveBeenCalledTimes(1);
    expect(introducePlanItem).toHaveBeenCalledTimes(1);
  });

  it('never shows a card count while catching up', async () => {
    await seedWords('w-mizu', 'w-ike');
    vi.mocked(planToday).mockResolvedValue(plan({ mode: 'catch-up', warmup: ['word:w-mizu|read', 'word:w-ike|read'], counts: undefined }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    await screen.findByLabelText('Reading');
    expect(counter()).toBe('Catching up');
    await answerWordRead(true);
    expect(counter()).toBe('Catching up');
    expect(document.body.textContent).not.toMatch(/\d+ \/ \d+/);
  });

  it('an anywhere sitting runs the warm-up without paper, and does not complete the day', async () => {
    await seedWords('w-ike');
    await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date(Date.now() - 9 * DAY) });
    await db.cards.put(dueCard('kanji:水', 'kanji', 'write'));
    vi.mocked(planToday).mockResolvedValue(plan({ sitting: 'anywhere', paperAllowed: false, warmup: ['kanji:水|write'] }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /Anywhere/ }));
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write on paper' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write it right' }));
    fireEvent.click(await screen.findByText('Correct'));
    await screen.findByRole('heading', { name: 'Done for now' });
    await waitFor(() => expect(streak).toHaveBeenCalled());
    expect(completeDay).not.toHaveBeenCalled();
    expect(finishStep).not.toHaveBeenCalled();
  });

  it('offers the make-up in the summary when the streak can be repaired', async () => {
    vi.mocked(completeDay).mockResolvedValue({ ...STREAK, makeupOffer: true, repairable: { date: '2026-10-13', deadline: new Date() } });
    vi.mocked(planToday).mockResolvedValue(plan({ teach: [{ items: [{ itemId: 'core:cw-0003', kind: 'core', key: 'cw-0003', priceSec: 35, stream: 'core' }] }] }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show the word' }));
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show the meaning' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    // The check: the listen card.
    fireEvent.click(await screen.findByRole('button', { name: 'Show the answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    const offer = await screen.findByRole('link', { name: /Make up Tuesday: 10 more minutes/ });
    expect(offer.getAttribute('href')).toBe('/session?mode=makeup');
    expect(await screen.findByText(/You can now/)).toBeTruthy();
  });

  it('starts the make-up from the summary’s offer as a fresh session, and Done goes back to Today', async () => {
    await seedWords('w-ike');
    vi.mocked(completeDay).mockResolvedValue({ ...STREAK, makeupOffer: true, repairable: { date: '2026-10-13', deadline: new Date() } });
    vi.mocked(planToday).mockResolvedValue(plan({ warmup: ['word:w-ike|read'] }));
    vi.mocked(planMakeup).mockResolvedValue(plan({ mode: 'makeup', warmup: ['word:w-ike|read'], counts: undefined }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    await answerWordRead(true);
    fireEvent.click(await screen.findByRole('link', { name: /Make up Tuesday/ }));

    // The make-up plans for itself and runs; the finished session is gone.
    await waitFor(() => expect(planMakeup).toHaveBeenCalledTimes(1));
    await screen.findByLabelText('Reading');
    expect(planToday).toHaveBeenCalledTimes(1);
    await answerWordRead(true);
    expect(await screen.findByRole('heading', { name: 'Done for now' })).toBeTruthy();
    await waitFor(() => expect(completeMakeup).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gradeCard).mock.calls.at(-1)?.[2]).toMatchObject({ makeup: true });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
  });
});
