import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import type { CanDoRecord, UnitSpec } from '../../lib/types.ts';
import type { CourseProgressV2 } from '../../srs/course.ts';
import type { LearnedCounts, RetentionStat } from '../../srs/progress.ts';
import LearnHub from '../../screens/LearnHub.tsx';
import { readyCanDos } from './CanDoList.tsx';
import { seasonSpan } from './SeasonCard.tsx';
import { renderAt, resetDb, UNITS } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => {
  const { dataMock, UNITS: units } = await import('./test-fixtures.tsx');
  return { ...dataMock, loadUnits: async () => state.units ?? units };
});

const state = vi.hoisted(() => ({
  progress: undefined as CourseProgressV2 | undefined,
  learned: undefined as LearnedCounts | undefined,
  retention: [] as RetentionStat[],
  hours: 0,
  speed: { latest: null as number | null, best: null as number | null },
  unit: 1,
  status: new Map<string, CanDoRecord>(),
  season: null as number | null,
  units: undefined as UnitSpec[] | undefined,
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
  state.units = undefined;
});

/** Unit `id`: one grammar point and two ready read checks. */
const unitSpec = (id: number, title: string): UnitSpec => ({
  ...UNITS[0], id, title, grammar: [`g${id}`],
  canDos: [1, 2].map((n) => ({
    id: `u${id}-cd${n}`, text: `${title} check ${n}`, ready: true,
    check: { kind: 'read' as const, instructions: '', material: '', questions: [] },
  })),
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

  it("lists the earlier units' checks that are ready, since the current unit's open only once it is done", async () => {
    state.units = [unitSpec(1, 'Hello'), unitSpec(2, 'Cafe'), unitSpec(3, 'Weekend'), unitSpec(4, 'Shopping')];
    // Units 1–3 taught; unit 4 is the one being taught now.
    await db.items.bulkPut(['g1', 'g2', 'g3'].map((g) => ({ id: `grammar:${g}`, kind: 'grammar' as const, key: g, introducedAt: new Date() })));
    state.unit = 4;
    state.status = new Map([['u2-cd1', { id: 'u2-cd1', unit: 2, attempts: 1, passedAt: new Date(), via: 'auto' }]]);
    renderAt('/learn', '/learn', <LearnHub />);
    const current = await card('Shopping');
    expect(current.textContent).toContain("After this unit's grammar");
    const ready = await card('Can-dos ready to try');
    const links = within(ready).getAllByRole('link');
    // Newest unit first, passed ones left out (they're on their own unit's list).
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/cando/u3-cd1', '/cando/u3-cd2', '/cando/u2-cd2', '/cando/u1-cd1', '/cando/u1-cd2',
    ]);
    expect(links[0].getAttribute('aria-label')).toBe('Weekend check 1, Unit 3 · Ready to try');
  });

  it('shows five ready checks, then the rest on request', () => {
    const units = [1, 2, 3, 4].map((n) => unitSpec(n, `Unit ${n}`));
    const ready = readyCanDos(units, 4, new Map(), new Set(['g1', 'g2', 'g3']));
    expect(ready.map((r) => r.cd.id)).toEqual(['u3-cd1', 'u3-cd2', 'u2-cd1', 'u2-cd2', 'u1-cd1', 'u1-cd2']);
    // A unit whose grammar isn't all in yet has nothing ready.
    expect(readyCanDos(units, 4, new Map(), new Set(['g1', 'g3'])).map((r) => r.cd.id)).toEqual(['u3-cd1', 'u3-cd2', 'u1-cd1', 'u1-cd2']);
  });

  it('moves focus to the first revealed check when "Show more" goes away', async () => {
    state.units = [1, 2, 3, 4].map((n) => unitSpec(n, `Unit ${n}`));
    await db.items.bulkPut(['g1', 'g2', 'g3'].map((g) => ({ id: `grammar:${g}`, kind: 'grammar' as const, key: g, introducedAt: new Date() })));
    state.unit = 4;
    renderAt('/learn', '/learn', <LearnHub />);
    const ready = await card('Can-dos ready to try');
    expect(within(ready).getAllByRole('link')).toHaveLength(5);
    fireEvent.click(within(ready).getByRole('button', { name: 'Show 1 more' }));
    const links = within(ready).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(within(ready).queryByRole('button', { name: /more/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(links[5]));
  });

  it('says "met" for introduced kana and grammar, and which kana the count covers', async () => {
    state.progress = { ...state.progress!, kanaIntroduced: 46, grammarIntroduced: 4 };
    renderAt('/learn', '/learn', <LearnHub />);
    expect(await screen.findByRole('link', { name: 'Kana chart, 46 of 92 basic kana met' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Grammar, 4 points met so far' })).toBeTruthy();
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

  it('shows the season finale with its own numbers, linking a paired couple to the showcase in Session C', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam' });
    state.season = 2;
    // Whole-course totals (lifetime hours 69) are not the season's.
    state.hours = 69;
    // Season 2 runs from day 84 to day 167 after the first study day (2026-07-01, mocked).
    const { from, to } = seasonSpan('2026-07-01', 2);
    expect([from, to]).toEqual(['2026-09-23', '2026-12-16']);
    const at = (key: string) => new Date(`${key}T12:00:00`);
    await db.items.bulkPut([
      { id: 'kanji:日', kind: 'kanji', key: '日', introducedAt: at('2026-08-01') },
      { id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: at('2026-10-01') },
      { id: 'kanji:火', kind: 'kanji', key: '火', introducedAt: at('2026-10-02') },
      { id: 'core:cw-0005', kind: 'core', key: 'cw-0005', introducedAt: at('2026-10-01') },
      { id: 'grammar:tai', kind: 'grammar', key: 'tai', introducedAt: at('2026-09-01') },
    ]);
    const day = (date: string, studyMs: number) => ({
      date, studyMs, togetherMs: 0, reviews: 0, correct: 0, reviewMs: 0, strandMs: 0, newItems: 0,
      newSec: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 }, minimumDone: true, goalMet: false, steps: [],
    });
    await db.days.bulkPut([day('2026-08-01', 10 * 3_600_000), day('2026-10-01', 2 * 3_600_000), day('2026-10-02', 3_600_000)]);
    renderAt('/learn', '/learn', <LearnHub />);
    const season = (await screen.findByText('Season 2 finale')).closest('section')!;
    const numbers = within(season).getAllByRole('listitem').map((li) => li.textContent);
    expect(numbers).toEqual(['2 new kanji', '1 new word', '0 new grammar points', '3 hours of study']);
    expect(season.textContent).not.toMatch(/69|kanji you can write/);
    expect(within(season).getByRole('link', { name: /Session C/ }).getAttribute('href')).toBe('/together/session/C');
    fireEvent.click(within(season).getByRole('button', { name: 'Done celebrating' }));
    await waitFor(() => expect(state.markMilestoneSeen).toHaveBeenCalledWith('season:2'));
    expect(state.recordMilestone).toHaveBeenCalledWith('season:2');
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
    expect(items[2].textContent).toContain('M2');
    expect(milestones.textContent).not.toMatch(/around day|Targets at 25 minutes/);
    expect(milestones.textContent).toContain('Introduction targets');
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
