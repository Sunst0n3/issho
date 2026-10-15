// The session screen's QA round 2 fixes, on mocked plans: no card counts in short sessions on a catch-up day (V008),
// the romaji helper follows the kana taught in the sitting (V019), an empty phone-only sitting says lessons still wait
// (V025), and the first check keeps a kanji's anchor reading back while the anchor's cards are still to come (V039).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord, CardType, ItemKind, ItemRecord, KanaRule } from '../../../lib/types.ts';
import Session from '../../../screens/Session.tsx';
import { introducePlanItem, loadCourseSnapshot, taughtKana, type CourseSnapshot, type NewItemPlan } from '../../../srs/course.ts';
import { streak, type StreakV2 } from '../../../srs/habits.ts';
import { planMicro, planToday, type DayPlan } from '../../../srs/planner.ts';
import { askedLater, mergeMasks } from '../ReviewBlock.tsx';
import { KANA, resetStudyDb, TAUGHT_DAY_3 } from '../test-utils.tsx';

/** A rule whose practice word holds the rule's own kana (が) next to a taught one (か). */
const RULE: KanaRule = {
  id: 'hira-dakuten',
  day: 6,
  script: 'hiragana',
  title: 'Voiced sounds',
  explanation: 'A small mark makes a sound voiced.',
  pairs: [{ from: 'か', to: 'が', romaji: 'ga' }],
  practiceWords: [{ kana: 'がか', en: 'painter' }],
};

vi.mock('../../../lib/data.ts', async () => {
  const { dataMock } = await import('../test-utils.tsx');
  return { ...dataMock, loadKanaRules: async () => [RULE] };
});
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);
vi.mock('../../../speech/recognition.ts', () => ({ recognitionAvailable: () => false, listen: vi.fn() }));
vi.mock('../../../speech/recorder.ts', () => ({ micAvailable: () => false }));
vi.mock('../../../sync/stats.ts', () => ({ pushStats: vi.fn(async () => true), useHousehold: () => ({ loading: false, refresh: async () => {} }) }));
vi.mock('../../../srs/planner.ts', () => ({
  planToday: vi.fn(),
  planMicro: vi.fn(),
  planMakeup: vi.fn(),
  startSitting: vi.fn(async () => {}),
  finishStep: vi.fn(async () => {}),
  leakMask: vi.fn(async () => ({ readings: new Set(), meanings: new Set(), kanji: new Set() })),
}));
vi.mock('../../../srs/habits.ts', () => ({
  completeDay: vi.fn(async () => STREAK),
  completeMicro: vi.fn(async () => {}),
  completeMakeup: vi.fn(async () => false),
  streak: vi.fn(),
  noteReviewProgress: vi.fn(async () => true),
}));
vi.mock('../../../srs/course.ts', async (original) => ({
  ...(await original<typeof import('../../../srs/course.ts')>()),
  introducePlanItem: vi.fn(),
  currentUnit: vi.fn(async () => 1),
  taughtKana: vi.fn(),
  loadCourseSnapshot: vi.fn(),
}));
vi.mock('../../../srs/progress.ts', async (original) => ({
  ...(await original<typeof import('../../../srs/progress.ts')>()),
  learnedToday: vi.fn(async () => []),
  retention: vi.fn(async () => []),
  addStudyTime: vi.fn(async () => {}),
}));
vi.mock('../../../srs/scheduler.ts', async (original) => ({
  ...(await original<typeof import('../../../srs/scheduler.ts')>()),
  gradeCard: vi.fn(async (id: string) => ({ id, due: new Date(Date.now() + 86_400_000) })),
}));

const DAY = 86_400_000;
const STREAK: StreakV2 = {
  current: 3, alive: true, longest: 5, daysThisMonth: 6, todayMinimum: true, todayGoal: true, tokensLeftThisWeek: 2,
  makeupOffer: false, week: [],
};

function plan(over: Partial<DayPlan> = {}): DayPlan {
  return {
    day: '2026-10-15', courseDay: 20, mode: 'normal', sitting: 'any', budgetMin: 25, estimateMin: 20, partOfDayDone: false,
    tomorrowMin: 18, strandMin: 4, warmup: [], bury: [], teach: [], pendingCheck: [], read: null, output: null, fluency: null,
    doneSteps: [], counts: { reviews: 0, newItems: 0 }, brake: false, offerExtraKanji: false, paperAllowed: true, courseComplete: false,
    ...over,
  };
}

function card(itemId: string, kind: ItemKind, type: CardType, due = new Date()): CardRecord {
  return { ...createEmptyCard(due), id: cardId(itemId, type), itemId, kind, type };
}

/** Review cards due an hour ago, for the warm-up. */
async function seedDue(...ids: string[]) {
  const items: ItemRecord[] = ids.map((id) => ({ id: `word:${id}`, kind: 'word', key: id, introducedAt: new Date(Date.now() - 10 * DAY) }));
  await db.items.bulkPut(items);
  await db.cards.bulkPut(ids.map((id) => ({ ...card(`word:${id}`, 'word', 'read', new Date(Date.now() - 3 * DAY)), state: 2, reps: 3, stability: 8, due: new Date(Date.now() - 3600_000) })));
}

function renderSession(path = '/session') {
  return render(
    <MemoryRouter initialEntries={['/', path]} initialIndex={1} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/session" element={<Session />} />
      </Routes>
    </MemoryRouter>,
  );
}

const counter = () => document.querySelector('.st-count')?.textContent ?? '';
const snapshot = (inSprint: boolean) => ({ courseDay: inSprint ? 6 : 20, inSprint, kana: KANA }) as unknown as CourseSnapshot;

beforeEach(async () => {
  await resetStudyDb();
  vi.mocked(planToday).mockReset();
  vi.mocked(planMicro).mockReset();
  vi.mocked(streak).mockReset().mockResolvedValue(STREAK);
  vi.mocked(introducePlanItem).mockReset();
  vi.mocked(taughtKana).mockReset().mockResolvedValue(new Set());
  vi.mocked(loadCourseSnapshot).mockReset().mockResolvedValue(snapshot(false));
});

afterEach(() => {
  cleanup();
});

describe('Session, QA round 2', () => {
  it('shows no card count in a welcome-back or micro session on a catch-up day (V008)', async () => {
    await seedDue('w-mizu', 'w-ike');
    vi.mocked(planMicro).mockResolvedValue(plan({ mode: 'welcome-back', warmup: ['word:w-mizu|read', 'word:w-ike|read'], counts: { reviews: 2, newItems: 0 } }));
    vi.mocked(planToday).mockResolvedValue(plan({ mode: 'catch-up', counts: undefined }));
    renderSession('/session?mode=welcome');
    await screen.findByLabelText('Reading');
    expect(counter()).toBe('Catching up');
    expect(document.body.textContent).not.toMatch(/\d+ \/ \d+/);

    cleanup();
    // On an ordinary day the count stays.
    vi.mocked(planToday).mockResolvedValue(plan());
    renderSession('/session?mode=micro');
    await screen.findByLabelText('Reading');
    expect(counter()).toBe('Warm-up 1 / 2');
  });

  it('an empty phone-only sitting says today’s lessons need a desk sitting, and offers the sitting choice again (V025)', async () => {
    vi.mocked(planToday).mockImplementation(async (_now, opts) => (opts?.sitting === 'anywhere'
      ? plan({ sitting: 'anywhere', paperAllowed: false, mode: 'sprint', courseDay: 1 })
      : plan({ mode: 'sprint', courseDay: 1, teach: [{ items: [{ itemId: 'kana:あ', kind: 'kana', key: 'あ', priceSec: 60, stream: 'sprint' }] }] })));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /Anywhere/ }));
    expect(await screen.findByRole('heading', { name: 'No reviews right now' })).toBeTruthy();
    expect(document.body.textContent).not.toContain("today's new items are done");
    expect(document.body.textContent).toContain('need a pen');
    const again = screen.getByRole('button', { name: 'Choose another sitting' });
    again.focus();
    fireEvent.click(again);
    const question = await screen.findByRole('heading', { name: 'Where are you?' });
    // The button that had focus is gone: focus moves to the question, not the page.
    expect(document.activeElement).toBe(question);
    const desk = screen.getByRole('button', { name: /At my desk/ });
    // While it plans, the chosen button keeps focus (aria-disabled, never disabled).
    desk.focus();
    fireEvent.click(desk);
    expect(desk.getAttribute('aria-disabled')).toBe('true');
    expect(desk).toHaveProperty('disabled', false);
    expect(document.activeElement).toBe(desk);

    cleanup();
    // Nothing left for a desk sitting either: all caught up.
    vi.mocked(planToday).mockImplementation(async (_now, opts) => plan({ sitting: opts?.sitting ?? 'any' }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /Anywhere/ }));
    expect(await screen.findByRole('heading', { name: "You're all caught up" })).toBeTruthy();
  });

  it('drops the romaji over a rule’s own kana in its lesson, and over kana taught earlier in the sitting (V019)', async () => {
    vi.mocked(loadCourseSnapshot).mockResolvedValue(snapshot(true));
    vi.mocked(taughtKana).mockResolvedValue(new Set(TAUGHT_DAY_3));
    vi.mocked(introducePlanItem).mockImplementation(async (p: NewItemPlan) => {
      const item: ItemRecord = { id: p.itemId, kind: 'kanaRule', key: p.key, introducedAt: new Date() };
      await db.items.put(item);
      return [{ item, cards: [], created: true }];
    });
    vi.mocked(planToday).mockResolvedValue(plan({
      mode: 'sprint', courseDay: 6,
      teach: [{ items: [{ itemId: 'kanaRule:hira-dakuten', kind: 'kanaRule', key: 'hira-dakuten', priceSec: 60, stream: 'sprint' }] }],
      read: { kind: 'kana-words', kanaWords: [{ kana: 'がか', en: 'painter', ref: 'kanaRule:hira-dakuten#0' }], sentences: [], minutes: 1 },
    }));
    const romaji = () => [...document.querySelectorAll('.st-romaji-ruby rt')].map((rt) => rt.textContent);
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /All of it/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read some words' }));
    expect(screen.getByText('Read each word aloud, then hear it')).toBeTruthy();
    expect(romaji()).not.toContain('ga');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    // The read step, after the rule was taught in this sitting.
    await waitFor(() => expect(counter()).toBe('Read'));
    expect(document.querySelector('.st-big')?.textContent).toBe('がか');
    expect(romaji()).toEqual([]);
  });

  it('asks a kanji write card before its anchor’s cards, with the anchor’s reading and audio kept back (V039)', async () => {
    await db.items.bulkPut([
      { id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() },
      { id: 'word:w-mizu', kind: 'word', key: 'w-mizu', introducedAt: new Date() },
    ]);
    await db.cards.bulkPut([card('kanji:水', 'kanji', 'write'), card('word:w-mizu', 'word', 'read')]);
    vi.mocked(planToday).mockResolvedValue(plan({ pendingCheck: ['word:w-mizu|read', 'kanji:水|write'] }));
    renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /At my desk/ }));
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(screen.getByText('water')).toBeTruthy();
    expect(screen.queryByText('みず')).toBeNull();
    expect(screen.queryByRole('button', { name: /Listen to/ })).toBeNull();
  });
});

describe('askedLater', () => {
  it('masks what the cards still to come ask: readings (read, produce), meanings, kanji to write', () => {
    const mask = askedLater(['word:w-mizu|read', 'core:cw-0002|produce', 'core:cw-0001|listen', 'kanji:水|write', 'kana:あ|write', 'grammar:g|build']);
    expect([...mask.readings]).toEqual(['word:w-mizu', 'core:cw-0002']);
    expect([...mask.meanings]).toEqual(['core:cw-0001']);
    expect([...mask.kanji]).toEqual(['水']);
    const merged = mergeMasks(mask, { readings: new Set(['word:x']), meanings: new Set(), kanji: new Set(['日']) });
    expect(merged.readings.has('word:x') && merged.readings.has('word:w-mizu')).toBe(true);
    expect([...merged.kanji]).toEqual(['水', '日']);
  });
});
