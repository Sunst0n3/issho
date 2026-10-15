import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quiz, TogetherState } from '../../shared/api.ts';
import { db } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind, RolePlay, StoryEntry, UnitSpec } from '../lib/types.ts';
import { DAY_MS, emptyDay } from './days.ts';
import {
  applyLocalVerdicts,
  applyPartnerVerdicts,
  buildQuizPool,
  buildWeekPlan,
  coupleSettledUnit,
  eligibleRolePlays,
  loadWeekPlan,
  partnerPrompt,
  taskTargets,
  teachMeKanji,
  weeklyCheckinCounts,
  type WeekPlanInput,
} from './together.ts';
import { at, resetDb, wordInfoOf } from './test-fixtures.ts';
import { newCardRecord } from './scheduler.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const NOW = at(2026, 3, 20, 20);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

async function card(itemId: string, type: CardType, opts: { introducedDaysAgo: number; dueIn?: number; stability?: number; state?: State; suspended?: boolean }): Promise<CardRecord> {
  const kind = itemId.slice(0, itemId.indexOf(':')) as ItemKind;
  const key = itemId.slice(itemId.indexOf(':') + 1);
  const introducedAt = ago(opts.introducedDaysAgo);
  if (!(await db.items.get(itemId))) await db.items.put({ id: itemId, kind, key, introducedAt, via: 'lesson' });
  const stability = opts.stability ?? 4;
  const due = new Date(NOW.getTime() + (opts.dueIn ?? 2) * DAY_MS);
  const record: CardRecord = {
    ...newCardRecord(itemId, kind, type, introducedAt),
    state: opts.state ?? State.Review,
    stability,
    difficulty: 5,
    reps: 2,
    last_review: new Date(due.getTime() - stability * DAY_MS),
    scheduled_days: stability,
    due,
    ...(opts.suspended ? { suspended: 'retired' as const } : {}),
  };
  await db.cards.put(record);
  return record;
}

describe('partnerPrompt', () => {
  it('writes what the asker reads out and checks against', () => {
    const anchor = wordInfoOf('word:1002')!;
    const write = partnerPrompt({ id: 'kanji:日|write', itemId: 'kanji:日', kind: 'kanji', type: 'write' }, { kanji: { char: '日', meanings: ['day'], on: [], kun: [], strokeCount: 4, components: [], parts: [] }, anchor });
    expect(write).toEqual({ key: 'kanji:日|write', kind: 'write', prompt: 'Write the kanji for "day" · □本 にほん', answer: '日' });
    const word = wordInfoOf('word:1002')!;
    expect(partnerPrompt({ id: 'word:1002|read', itemId: 'word:1002', kind: 'word', type: 'read' }, { word })).toMatchObject({ kind: 'read', prompt: '日本', answer: 'にほん' });
    expect(partnerPrompt({ id: 'word:1002|produce', itemId: 'word:1002', kind: 'word', type: 'produce' }, { word })).toMatchObject({ kind: 'produce', prompt: 'Japan', answer: '{日本|にほん}' });
  });
});

describe('buildQuizPool', () => {
  it('partner: items 2–10 days old plus recent lapses, never today’s, kinds mixed, at most 10', async () => {
    for (let i = 0; i < 6; i++) await card(`kanji:${String.fromCodePoint(0x6000 + i)}`, 'write', { introducedDaysAgo: 3 + i });
    for (let i = 0; i < 6; i++) await card(`word:${7000 + i}`, 'read', { introducedDaysAgo: 4 });
    await card('grammar:wa-desu', 'build', { introducedDaysAgo: 5 });
    await card('word:today', 'read', { introducedDaysAgo: 0 });
    await card('word:old', 'read', { introducedDaysAgo: 30 });
    await card('word:lapsed', 'read', { introducedDaysAgo: 30 });
    await db.reviewLogs.add({ cardId: 'word:lapsed|read', itemId: 'word:lapsed', kind: 'word', type: 'read', grade: Rating.Again, reviewedAt: ago(2), durationMs: 1, mode: 'typed', prevState: State.Review, elapsedDays: 5, context: 'review' });
    const pool = await buildQuizPool('partner', NOW);
    const keys = pool.map((p) => p.key);
    expect(pool).toHaveLength(10);
    expect(keys).not.toContain('word:today|read');
    expect(keys).not.toContain('word:old|read');
    expect(keys[1]).toBe('word:lapsed|read');
    expect(pool.slice(0, 3).map((p) => p.kind)).toEqual(['write', 'read', 'build']);
  });

  it('monthly: Review cards, lowest retrievability first, at most 20', async () => {
    for (let i = 0; i < 25; i++) await card(`word:${8000 + i}`, 'read', { introducedDaysAgo: 40, dueIn: -i, stability: 5 });
    const pool = await buildQuizPool('monthly', NOW);
    expect(pool).toHaveLength(20);
    expect(pool[0].key).toBe('word:8024|read');
  });

  it('dictation: up to 5 recent kanji with an anchor and a live write card, weakest first', async () => {
    await card('kanji:日', 'write', { introducedDaysAgo: 5, stability: 2 });
    await card('word:1001', 'read', { introducedDaysAgo: 5 });
    await card('kanji:人', 'write', { introducedDaysAgo: 3, stability: 1 });
    await card('word:1007', 'read', { introducedDaysAgo: 3 });
    await card('kanji:本', 'write', { introducedDaysAgo: 4, suspended: true });
    await card('word:1006', 'read', { introducedDaysAgo: 4 });
    await card('kanji:乙', 'write', { introducedDaysAgo: 4 });
    await card('kanji:元', 'write', { introducedDaysAgo: 25 });
    const pool = await buildQuizPool('dictation', NOW);
    expect(pool).toEqual([
      { key: 'kanji:人|write', kind: 'write', prompt: 'ひと · person', answer: '人' },
      { key: 'kanji:日|write', kind: 'write', prompt: 'ひ · day; sun', answer: '日' },
    ]);
  });
});

describe('applyPartnerVerdicts', () => {
  const quiz = (id: string, verdicts: Quiz['result']): Quiz => ({
    id, kind: 'partner', fromMemberId: 'me', toMemberId: 'you', createdAt: ago(0.1).toISOString(), items: [], result: verdicts,
  });
  const result = (verdicts: [string, 'right' | 'close' | 'wrong'][]) => ({
    correct: 0, total: verdicts.length, finishedAt: NOW.toISOString(), missed: [], verdicts: verdicts.map(([key, verdict]) => ({ key, verdict })),
  });

  it('reschedules only cards near their due date and logs an encounter for the rest', async () => {
    await card('word:1', 'read', { introducedDaysAgo: 10, dueIn: 1 });
    await card('word:2', 'read', { introducedDaysAgo: 10, dueIn: 1 });
    await card('word:3', 'read', { introducedDaysAgo: 10, dueIn: 1 });
    const far = await card('word:4', 'read', { introducedDaysAgo: 10, dueIn: 3 });
    const counts = await applyPartnerVerdicts(quiz('q1', result([['word:1|read', 'right'], ['word:2|read', 'close'], ['word:3|read', 'wrong'], ['word:4|read', 'right'], ['word:x|read', 'right']])), NOW);
    expect(counts).toEqual({ graded: 3, practiced: 1 });
    const logs = await db.reviewLogs.orderBy('id').toArray();
    expect(logs.map((l) => [l.cardId, l.grade, l.mode, l.context])).toEqual([
      ['word:1|read', Rating.Good, 'partner', 'partner'],
      ['word:2|read', Rating.Hard, 'partner', 'partner'],
      ['word:3|read', Rating.Again, 'partner', 'partner'],
    ]);
    expect((await db.cards.get('word:4|read'))?.due).toEqual(far.due);
    expect(await db.encounters.where('itemId').equals('word:4').count()).toBe(1);
    expect((await db.days.toArray()).reduce((s, d) => s + d.studyMs, 0)).toBe(0);
  });

  it('applies a quiz once, even twice at the same time', async () => {
    await card('word:1', 'read', { introducedDaysAgo: 10, dueIn: 1 });
    const q = quiz('q2', result([['word:1|read', 'right']]));
    const [a, b] = await Promise.all([applyPartnerVerdicts(q, NOW), applyPartnerVerdicts(q, NOW)]);
    expect(a).toEqual(b);
    expect(await applyPartnerVerdicts(q, NOW)).toEqual({ graded: 1, practiced: 0 });
    expect(await db.reviewLogs.count()).toBe(1);
    expect((await db.partnerQuizzes.get('q2'))?.appliedAt).toEqual(NOW);
  });

  it('grades the kanji write card from a dictation verdict, and pass-and-play verdicts', async () => {
    await card('kanji:日', 'write', { introducedDaysAgo: 5, dueIn: 0.5 });
    await applyPartnerVerdicts({ ...quiz('d1', result([['kanji:日|write', 'wrong']])), kind: 'dictation' }, NOW);
    expect((await db.cards.get('kanji:日|write'))?.state).toBe(State.Relearning);
    await card('word:1', 'read', { introducedDaysAgo: 10, dueIn: 1 });
    const items = [{ key: 'word:1|read', kind: 'read' as const, prompt: '', answer: '' }];
    expect(await applyLocalVerdicts('local-1', items, [{ key: 'word:1|read', verdict: 'close' }, { key: 'kanji:日|write', verdict: 'right' }], NOW)).toEqual({ graded: 1, practiced: 0 });
    expect(await applyLocalVerdicts('local-1', items, [{ key: 'word:1|read', verdict: 'close' }], NOW)).toEqual({ graded: 1, practiced: 0 });
  });

  it('ignores v1 kanji quizzes', async () => {
    expect(await applyPartnerVerdicts({ ...quiz('k', result([])), kind: 'kanji' }, NOW)).toEqual({ graded: 0, practiced: 0 });
  });
});

describe('teach-me and targets', () => {
  it('picks the weakest recent kanji', async () => {
    await card('kanji:日', 'write', { introducedDaysAgo: 5, stability: 3 });
    await card('kanji:人', 'write', { introducedDaysAgo: 3, stability: 1 });
    await card('kanji:本', 'write', { introducedDaysAgo: 1, stability: 0.5 });
    expect(await teachMeKanji(NOW)).toBe('人');
  });

  it('settles on the lower unit of the two', () => {
    expect(coupleSettledUnit(4, 2)).toBe(2);
    expect(coupleSettledUnit(4)).toBe(4);
  });

  it('builds task targets from the authored ones both met recently, topped up from both, at most 8', () => {
    const mine = ['core:cw-0010', 'grammar:tai-want', 'kanji:日', 'core:cw-0011', 'word:1', 'word:2'];
    const partner = ['core:cw-0020', 'grammar:tai-want', 'core:cw-0021', 'word:3', 'word:4'];
    const targets = taskTargets(['grammar:tai-want', 'core:cw-0021', 'core:cw-0999'], mine, partner);
    expect(targets).toEqual(['grammar:tai-want', 'core:cw-0021', 'core:cw-0010', 'core:cw-0020', 'kanji:日', 'core:cw-0011', 'word:3', 'word:1']);
    expect(targets).not.toContain('core:cw-0999');
    expect(taskTargets([], ['a', 'b'], ['c'])).toEqual(['a', 'c', 'b']);
  });
});

function unit(id: number, patch: Partial<UnitSpec> = {}): UnitSpec {
  return {
    id, title: `Unit ${id}`, titleJp: '', level: 'A1', topic: '', grammar: [`g${id}a`, `g${id}b`], coreWordCeiling: id * 60, canDos: [],
    conversation: `rp-u0${id}`,
    task: { id: `u0${id}-task`, canDo: '', goal: '', outcomeQuestion: '', roles: { a: '', b: '' }, infoA: '', infoB: '', targets: [], register: 'mixed', twist: '', scripted: [], ready: true },
    capstone: { title: '', brief: '', minLinesEach: 6, structures: [] },
    ...patch,
  };
}
const script = (id: string, patch: Partial<RolePlay> = {}): RolePlay => ({
  id, title: id, titleJp: '', setting: '', level: 1, register: 'mixed', targets: [], roles: { a: { name: '', nameJp: '' }, b: { name: '', nameJp: '' } }, lines: [], ...patch,
});
const tale = (id: string, level: StoryEntry['level'], unitId: number): StoryEntry => ({
  id, level, unit: unitId, title: id, titleJp: '', topic: '', grammar: [], sentences: [], gist: { q: '', options: [], answer: 0 }, chars: 0, refs: [],
});
const emptyState = (patch: Partial<TogetherState> = {}): TogetherState => ({ slots: [], goal: null, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [], ...patch });

describe('buildWeekPlan', () => {
  const units = [unit(1), unit(2), unit(3)];
  const roleplays = [script('rp-u01'), script('rp-u02'), script('rp-u03'), script('legacy-cafe', { unit: 2, targets: ['core:cw-0005'] })];
  const base = (patch: Partial<WeekPlanInput> = {}): WeekPlanInput => ({
    week: '2026-03-16',
    slots: [{ session: 'A', weekday: 2, time: '20:00' }, { session: 'B', weekday: 4, time: '20:00' }, { session: 'C', weekday: 7, time: '19:30' }],
    state: emptyState(),
    units,
    roleplays,
    stories: [tale('st-l1', 'L1', 2), tale('st-l0-b', 'L0', 3), tale('st-l0-a', 'L0', 3), tale('st-start', 'start', 1)],
    me: { settledUnit: 2, readyStories: ['st-l1', 'st-l0-b', 'st-l0-a'], coreReached: 100, grammarReached: 10 },
    partner: { settledUnit: 1, readyStories: ['st-l1', 'st-l0-b', 'st-start'], coreReached: 50, grammarReached: 6 },
    usedShared: new Set(),
    seasonFinale: false,
    ...patch,
  });

  it('places the sessions on their slot days', () => {
    const plan = buildWeekPlan(base());
    expect(plan.sessions).toEqual([
      { id: 'A', day: '2026-03-17', time: '20:00' },
      { id: 'B', day: '2026-03-19', time: '20:00' },
      { id: 'C', day: '2026-03-22', time: '19:30' },
    ]);
    expect(plan.monthly).toBe(false);
    expect(plan.capstoneUnit).toBeUndefined();
  });

  it('adds the monthly session in the week of the month’s first Saturday, with the capstone', () => {
    const plan = buildWeekPlan(base({ week: '2026-03-30', state: emptyState({ capstones: [] }) }));
    expect(plan.monthly).toBe(true);
    expect(plan.sessions.at(-1)).toEqual({ id: 'monthly', day: '2026-04-04', time: '19:30' });
    expect(plan.capstoneUnit).toBe(1);
    expect(buildWeekPlan(base({ week: '2026-03-30', state: emptyState({ capstones: [{ unit: 1, date: '2026-03-01' }] }) })).capstoneUnit).toBeUndefined();
  });

  it('takes the conversation stage from the state, capped at 1 above the settled unit', () => {
    expect(buildWeekPlan(base()).conversation).toEqual({ scriptId: 'rp-u01', stage: 1 });
    expect(buildWeekPlan(base({ state: emptyState({ stages: { 'rp-u01': 3 } }) })).conversation).toEqual({ scriptId: 'rp-u01', stage: 3 });
    expect(buildWeekPlan(base({ state: emptyState({ stages: { 'rp-u01': 5, 'rp-u02': 3 } }) })).conversation).toEqual({ scriptId: 'rp-u02', stage: 1 });
    expect(buildWeekPlan(base({ state: emptyState({ stages: { 'rp-u01': 5, 'rp-u02': 5 } }) })).conversation).toBeUndefined();
  });

  it('runs a task only from a settled unit, its repeat after 2 days, else a free role-play', () => {
    expect(buildWeekPlan(base()).task).toEqual({ unit: 1, taskId: 'u01-task', repeat: false });
    const ranTwoDaysBefore = emptyState({ tasks: [{ taskId: 'u01-task', date: '2026-03-17', repeat: false }] });
    expect(buildWeekPlan(base({ state: ranTwoDaysBefore })).task).toEqual({ unit: 1, taskId: 'u01-task', repeat: true });
    const ranYesterday = emptyState({ tasks: [{ taskId: 'u01-task', date: '2026-03-18', repeat: false }] });
    const none = buildWeekPlan(base({ state: ranYesterday }));
    expect(none.task).toBeUndefined();
    expect(none.rolePlayId).toBe('legacy-cafe');
    const unsettled = buildWeekPlan(base({ partner: { ...base().partner!, settledUnit: 0 } }));
    expect(unsettled.task).toBeUndefined();
    expect(unsettled.rolePlayId).toBe('rp-u01');
  });

  it('reads "introduced for both" from the grammar order, which a content reorder can move away from the unit lists', () => {
    const ranYesterday = emptyState({ tasks: [{ taskId: 'u01-task', date: '2026-03-18', repeat: false }] });
    const late = script('free-late-grammar', { unit: 2, targets: ['grammar:g3a', 'grammar:g3b', 'core:cw-0900'] });
    const input = base({ state: ranYesterday, roleplays: [...roleplays.slice(0, 3), late, roleplays[3]] });
    // By position in the unit lists g3a and g3b are points 5 and 6 (≤ 6 reached by both): one target left, eligible.
    expect(buildWeekPlan(input).rolePlayId).toBe('free-late-grammar');
    // Their real order is 30 and 31: three targets are not introduced for both, so the script is not eligible.
    const grammarOrder = new Map([['g1a', 1], ['g1b', 2], ['g2a', 3], ['g2b', 4], ['g3a', 30], ['g3b', 31]]);
    expect(buildWeekPlan({ ...input, grammarOrder }).rolePlayId).toBe('legacy-cafe');
  });

  it('shares the first story ready for both, by level, not used before', () => {
    expect(buildWeekPlan(base()).storyId).toBe('st-l0-b');
    expect(buildWeekPlan(base({ usedShared: new Set(['st-l0-b']) })).storyId).toBe('st-l1');
    expect(buildWeekPlan(base({ partner: undefined })).storyId).toBe('st-l0-a');
  });

  it('follows the season finale for the showcase', () => {
    expect(buildWeekPlan(base({ seasonFinale: true })).showcase).toBe(true);
    expect(buildWeekPlan(base()).showcase).toBe(false);
  });
});

describe('eligibleRolePlays', () => {
  it('drops core conversations and scripts with more than 2 targets not introduced for both', () => {
    const scripts = [
      script('rp-u01'),
      script('free-ok', { unit: 2, targets: ['core:cw-0001', 'core:cw-0900', 'grammar:x'] }),
      script('free-hard', { unit: 2, targets: ['core:cw-0900', 'core:cw-0901', 'grammar:x'] }),
      script('free-later', { unit: 5 }),
      script('free-any'),
    ];
    const introducedForBoth = (t: string) => t === 'core:cw-0001';
    expect(eligibleRolePlays(scripts, new Set(['rp-u01']), introducedForBoth, 2).map((s) => s.id)).toEqual(['free-ok', 'free-any']);
  });
});

describe('loadWeekPlan and the check-in', () => {
  it('assembles the plan from local data and caches it', async () => {
    const plan = await loadWeekPlan({ state: emptyState({ slots: [{ session: 'A', weekday: 3, time: '20:00' }] }) }, NOW);
    expect(plan.week).toBe('2026-03-16');
    expect(plan.sessions).toEqual([{ id: 'A', day: '2026-03-18', time: '20:00' }]);
    expect((await db.togetherPlans.get('2026-03-16'))?.plan).toEqual(plan);
  });

  it('counts the week so far', async () => {
    await db.items.bulkPut([
      { id: 'kanji:日', kind: 'kanji', key: '日', introducedAt: at(2026, 3, 17) },
      { id: 'word:1', kind: 'word', key: '1', introducedAt: at(2026, 3, 17) },
      { id: 'core:cw-0001', kind: 'core', key: 'cw-0001', introducedAt: at(2026, 3, 18) },
      { id: 'grammar:wa-desu', kind: 'grammar', key: 'wa-desu', introducedAt: at(2026, 3, 19) },
      { id: 'kanji:人', kind: 'kanji', key: '人', introducedAt: at(2026, 3, 15) },
      { id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: at(2026, 3, 17), via: 'placement' },
    ]);
    await db.days.bulkPut([
      { ...emptyDay('2026-03-17'), studyMs: 20 * 60_000, togetherMs: 15 * 60_000 },
      { ...emptyDay('2026-03-15'), studyMs: 99 * 60_000 },
    ]);
    expect(await weeklyCheckinCounts('2026-03-16', NOW)).toEqual({ kanji: 1, words: 2, grammar: 1, minutes: 35 });
  });
});

