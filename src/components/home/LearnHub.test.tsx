import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import type { CanDoRecord } from '../../lib/types.ts';
import type { CourseProgressV2 } from '../../srs/course.ts';
import type { LearnedCounts, RetentionStat } from '../../srs/progress.ts';
import LearnHub from '../../screens/LearnHub.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const state = vi.hoisted(() => ({
  progress: undefined as CourseProgressV2 | undefined,
  learned: undefined as LearnedCounts | undefined,
  retention: [] as RetentionStat[],
  hours: 0,
  speed: { latest: null as number | null, best: null as number | null },
  unit: 1,
  status: new Map<string, CanDoRecord>(),
  season: null as number | null,
  chapterItems: vi.fn(async (_chapter: number) => ({ from: '2026-09-01', to: null as string | null, kanji: [] as string[], words: [] as string[], grammar: [] as string[] })),
  recordMilestone: vi.fn(async () => {}),
  markMilestoneSeen: vi.fn(async () => {}),
}));

vi.mock('../../srs/course.ts', () => ({
  courseProgress: async () => state.progress,
  currentUnit: async () => state.unit,
}));
vi.mock('../../srs/habits.ts', () => ({ firstStudyDay: async () => '2026-07-01' }));
vi.mock('../../srs/progress.ts', () => ({
  learnedCounts: async () => state.learned,
  retention: async () => state.retention,
  hoursTotal: async () => state.hours,
  readingSpeed: async () => state.speed,
}));
vi.mock('../../srs/candos.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../srs/candos.ts')>()),
  canDoStatus: async () => state.status,
}));
vi.mock('../../srs/milestones.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../srs/milestones.ts')>()),
  chapterItems: state.chapterItems,
  seasonFinaleDue: () => state.season,
  recordMilestone: state.recordMilestone,
  markMilestoneSeen: state.markMilestoneSeen,
}));

const LEARNED: LearnedCounts = {
  kanaLearned: 92, kanjiCanWrite: 40, kanjiCanRead: 300, wordsLearned: 640, grammarLearned: 20,
  kanjiIntroduced: 120, wordsIntroduced: 700, grammarIntroduced: 40,
};

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam' });
  state.progress = {
    courseDay: 80, sprintDone: true, kanaIntroduced: 92, kanaTotal: 92, kanjiIntroduced: 32, kanjiTotal: 2136,
    coreIntroduced: 300, grammarIntroduced: 40, unit: 1, courseComplete: false,
  };
  state.learned = LEARNED;
  state.retention = [];
  state.hours = 0;
  state.speed = { latest: null, best: null };
  state.unit = 1;
  state.status = new Map();
  state.season = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card = async (name: string | RegExp) => (await screen.findByRole('heading', { name })).closest('section')!;

describe('LearnHub', () => {
  it('shows the decodable share of a typical text: 83 % at 300 can-read kanji, with the known words', async () => {
    renderAt('/learn', '/learn', <LearnHub />);
    const coverage = await card('Reading coverage');
    expect(coverage.textContent).toMatch(/You can decode about 83\s% of the words in a typical text/);
    expect(coverage.textContent).toContain('640 words known');
  });

  it('shows the next goal below 100 can-read kanji', async () => {
    state.learned = { ...LEARNED, kanjiCanRead: 42 };
    renderAt('/learn', '/learn', <LearnHub />);
    const coverage = await card('Reading coverage');
    expect(coverage.textContent).toMatch(/At 100 kanji: about 74\s% of the words/);
    expect(coverage.textContent).toContain('42 kanji you can read');
  });

  it('hides the retention card while there is not enough to say', async () => {
    state.retention = [{ family: 'write', week: { n: 4, rate: null }, month: { n: 0, rate: null } }];
    renderAt('/learn', '/learn', <LearnHub />);
    await card('Reading coverage');
    expect(screen.queryByRole('heading', { name: 'Real recall' })).toBeNull();
  });

  it('shows real recall at about a week and a month by card family', async () => {
    state.retention = [
      { family: 'write', week: { n: 20, rate: 0.91 }, month: { n: 12, rate: 0.87 } },
      { family: 'listen', week: { n: 3, rate: null }, month: { n: 2, rate: null } },
    ];
    renderAt('/learn', '/learn', <LearnHub />);
    const recall = await card('Real recall');
    const row = within(recall).getByRole('row', { name: /Handwriting/ });
    expect(row.textContent).toMatch(/91\s%.*87\s%/);
    expect(within(recall).queryByRole('row', { name: /Listening/ })).toBeNull();
  });

  it('shows hours against the benchmarks', async () => {
    state.hours = 125.4;
    renderAt('/learn', '/learn', <LearnHub />);
    const hours = await card('Hours');
    expect(hours.textContent).toContain('125 hours so far');
    expect(hours.textContent).toContain('old JLPT N5250–400 h');
    expect(hours.textContent).toContain('old JLPT N4500–750 h');
    expect(hours.textContent).toContain('2,200 h');
  });

  it('shows reading speed only once there is a timed re-read', async () => {
    renderAt('/learn', '/learn', <LearnHub />);
    await card('Hours');
    expect(screen.queryByRole('heading', { name: 'Reading speed' })).toBeNull();
    cleanup();
    state.speed = { latest: 180, best: 210 };
    renderAt('/learn', '/learn', <LearnHub />);
    expect((await card('Reading speed')).textContent).toContain('180 characters a minute');
  });

  it("lists the unit's can-dos as passed, ready, waiting for grammar or coming soon", async () => {
    state.status = new Map([['u01-cd2', { id: 'u01-cd2', unit: 1, attempts: 2, passedAt: new Date(), via: 'auto' }]]);
    await db.items.add({ id: 'grammar:wa-desu', kind: 'grammar', key: 'wa-desu', introducedAt: new Date() });
    renderAt('/learn', '/learn', <LearnHub />);
    const unit = await card('Hello, us');
    expect(unit.textContent).toContain('1 of 3 can-dos passed');
    expect(within(unit).getByRole('link', { name: 'Read a name card, Passed' }).getAttribute('href')).toBe('/cando/u01-cd2');
    // ka-question isn't introduced yet: the speak can-do waits.
    expect(unit.textContent).toContain("Speaking check · After this unit's grammar");
    expect(unit.textContent).toContain('Check coming soon');
    expect(within(unit).queryByRole('link', { name: /Greet each other/ })).toBeNull();

    cleanup();
    await db.items.add({ id: 'grammar:ka-question', kind: 'grammar', key: 'ka-question', introducedAt: new Date() });
    renderAt('/learn', '/learn', <LearnHub />);
    const ready = await card('Hello, us');
    expect(within(ready).getByRole('link', { name: 'Greet each other at any time of day, Ready to try' }).getAttribute('href'))
      .toBe('/cando/u01-cd1');
  });

  it('lists what a chapter taught: its kanji, words and grammar', async () => {
    state.chapterItems.mockImplementation(async (chapter: number) => (chapter === 3
      ? { from: '2026-10-01', to: null, kanji: ['水', '休'], words: ['core:cw-0005', 'word:w-yasumi'], grammar: ['tai'] }
      : { from: '2026-09-01', to: '2026-09-30', kanji: ['日'], words: [], grammar: [] }));
    renderAt('/learn', '/learn', <LearnHub />);
    const chapter = await card('Chapter 3 · 2 of 15 done');
    expect(chapter.textContent).toContain('Unit theme: Hello, us');
    fireEvent.click(within(chapter).getByRole('button', { name: /What this chapter taught/ }));
    await waitFor(() => expect(within(chapter).getByRole('link', { name: '水, water' })).toBeTruthy());
    expect(within(chapter).getByRole('link', { name: '休, rest' })).toBeTruthy();
    expect(chapter.textContent).toContain('休み');
    expect(chapter.textContent).toContain('〜たい');
    expect(state.chapterItems).toHaveBeenCalledWith(3);

    fireEvent.click(within(chapter).getByRole('button', { name: /Chapter 2/ }));
    await waitFor(() => expect(within(chapter).getByRole('link', { name: '日, day' })).toBeTruthy());
    expect(within(chapter).getByRole('button', { name: /Chapter 0 · Kana/ })).toBeTruthy();
  });

  it('shows the season finale, linking a paired couple to the showcase in Session C', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam' });
    state.season = 1;
    state.hours = 40;
    renderAt('/learn', '/learn', <LearnHub />);
    const season = (await screen.findByText('Season 1 finale')).closest('section')!;
    expect(season.textContent).toContain('40 kanji you can write');
    expect(within(season).getByRole('link', { name: /Session C/ }).getAttribute('href')).toBe('/together/session/C');
    fireEvent.click(within(season).getByRole('button', { name: 'Done celebrating' }));
    await waitFor(() => expect(state.markMilestoneSeen).toHaveBeenCalledWith('season:1'));
    expect(state.recordMilestone).toHaveBeenCalledWith('season:1');
  });

  it('offers a passed can-do to run again when not paired', async () => {
    state.season = 2;
    state.status = new Map([['u01-cd2', { id: 'u01-cd2', unit: 1, attempts: 1, passedAt: new Date(), via: 'auto' }]]);
    renderAt('/learn', '/learn', <LearnHub />);
    const season = (await screen.findByText('Season 2 finale')).closest('section')!;
    expect(within(season).getByRole('link', { name: /Run a can-do you've passed/ }).getAttribute('href')).toBe('/cando/u01-cd2');
  });

  it('shows the milestones as targets, with the next one marked', async () => {
    renderAt('/learn', '/learn', <LearnHub />);
    const milestones = await card('Milestones');
    const items = within(milestones).getAllByRole('listitem');
    expect(items.map((li) => li.className)).toEqual([
      'hm-milestone reached', 'hm-milestone reached', 'hm-milestone next', 'hm-milestone later', 'hm-milestone later',
    ]);
    expect(items[2].getAttribute('aria-current')).toBe('step');
    expect(items[2].textContent).toContain('M2 · around day 180');
    expect(items[2].textContent).toContain('175 kanji, 900 words, 60 grammar points');
    expect(items[3].textContent).toContain('265–310 kanji');
  });

  it('counts M0 as reached only once every kana is in, whatever the words and grammar', async () => {
    state.progress = { ...state.progress!, courseDay: 14, sprintDone: false, kanaIntroduced: 80, kanjiIntroduced: 0, grammarIntroduced: 2 };
    state.learned = { ...LEARNED, kanjiIntroduced: 0, wordsIntroduced: 36, grammarIntroduced: 2 };
    renderAt('/learn', '/learn', <LearnHub />);
    const first = within(await card('Milestones')).getAllByRole('listitem')[0];
    expect(first.className).toBe('hm-milestone next');
    expect(first.textContent).toContain('all 92 kana, 35 words, 2 grammar points');
  });

  it('has no 2,136 bar', async () => {
    renderAt('/learn', '/learn', <LearnHub />);
    await card('Hours');
    expect(document.body.textContent).not.toMatch(/2,136|2136/);
    expect(screen.getByRole('link', { name: /^Library, 32 kanji and 700 words so far/ }).getAttribute('href')).toBe('/library');
  });
});
