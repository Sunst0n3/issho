import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey, db, updateSettings } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind, ItemRecord, SentenceEntry } from '../lib/types.ts';
import { applyPlacement, introducePlanItem } from './course.ts';
import { addDays, DAY_MS, emptyDay, getDay } from './days.ts';
import { fluencySlotOpen } from './fluency.ts';
import { strandMinutes } from './governor.ts';
import { upgradeSpelling } from './items.ts';
import {
  batchItems,
  finishStep,
  leakMask,
  MICRO_SECONDS,
  nextStudyDayStart,
  orderWarmup,
  planMakeup,
  planMicro,
  planToday,
  siblingGroups,
  startSitting,
  type WarmupCard,
} from './planner.ts';
import { gradeCard, newCardRecord } from './scheduler.ts';
import { at, BASIC_HIRAGANA, BASIC_KATAKANA, fixtures, resetDb, RULES } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

/** Friday 2026-03-20, 9 a.m. */
const NOW = at(2026, 3, 20, 9);
const TODAY = dayKey(NOW);
const daysAgo = (n: number, h = 9) => new Date(NOW.getTime() - n * DAY_MS + (h - 9) * 3_600_000);

/** Today is course day n: n − 1 study days before it, the whole sprint introduced on the first. */
async function seedCourseDay(n: number): Promise<void> {
  await db.days.bulkPut(
    Array.from({ length: n - 1 }, (_, i) => ({ ...emptyDay(addDays(TODAY, -(i + 1))), reviews: 5, studyMs: 1_200_000, minimumDone: true })),
  );
  const first = daysAgo(n - 1);
  const items: ItemRecord[] = [
    ...[...BASIC_HIRAGANA, ...BASIC_KATAKANA].map((c): ItemRecord => ({ id: `kana:${c}`, kind: 'kana', key: c, introducedAt: first, via: 'lesson' })),
    ...RULES.map((r): ItemRecord => ({ id: `kanaRule:${r.id}`, kind: 'kanaRule', key: r.id, introducedAt: first, via: 'lesson' })),
  ];
  await db.items.bulkPut(items);
}

/** An item (introduced `introducedDaysAgo`) with one card. */
async function addCard(
  itemId: string,
  type: CardType,
  opts: { introducedDaysAgo?: number; state?: State; dueDaysAgo?: number; stability?: number } = {},
): Promise<CardRecord> {
  const [kind, key] = [itemId.slice(0, itemId.indexOf(':')) as ItemKind, itemId.slice(itemId.indexOf(':') + 1)];
  const introducedAt = daysAgo(opts.introducedDaysAgo ?? 20);
  if (!(await db.items.get(itemId))) await db.items.put({ id: itemId, kind, key, introducedAt, via: 'lesson' });
  const state = opts.state ?? State.Review;
  const stability = opts.stability ?? 5;
  const due = daysAgo(opts.dueDaysAgo ?? 0);
  const card: CardRecord = {
    ...newCardRecord(itemId, kind, type, introducedAt),
    state,
    stability,
    difficulty: 5,
    reps: state === State.New ? 0 : 3,
    last_review: state === State.New ? undefined : new Date(due.getTime() - stability * DAY_MS),
    scheduled_days: stability,
    due: state === State.New ? introducedAt : due,
  };
  await db.cards.put(card);
  return card;
}

describe('pure helpers', () => {
  it('groups a card with its siblings', () => {
    expect(siblingGroups({ itemId: 'kanji:日', kind: 'kanji', type: 'write' }, [])).toEqual(['item:kanji:日', 'k:日']);
    expect(siblingGroups({ itemId: 'word:1002', kind: 'word', type: 'read' }, ['日', '本'])).toEqual(['item:word:1002', 'k:日', 'k:本']);
    expect(siblingGroups({ itemId: 'grammar:x', kind: 'grammar', type: 'build' }, [])).toEqual(['item:grammar:x']);
  });

  const warm = (id: string, patch: Partial<WarmupCard>): WarmupCard => ({
    id, itemId: id, type: 'read', state: State.Review, r: 0.9, due: NOW, introducedDay: '2026-01-01', groups: [`item:${id}`], value: 0, ...patch,
  });

  it("orders yesterday's learning cards first, then other learning cards, then reviews by retrievability", () => {
    const cards = [
      warm('review-high', { r: 0.95 }),
      warm('review-low', { r: 0.6 }),
      warm('learning-old', { state: State.Learning, introducedDay: '2026-03-10', due: daysAgo(0.1) }),
      warm('learning-yesterday', { state: State.Learning, introducedDay: '2026-03-19', due: daysAgo(0.05) }),
      warm('review-tie-valuable', { r: 0.6, value: 2 }),
    ];
    const { order } = orderWarmup(cards, { yesterday: '2026-03-19', takenGroups: new Set(), catchUp: false });
    expect(order).toEqual(['learning-yesterday', 'learning-old', 'review-tie-valuable', 'review-low', 'review-high']);
  });

  it('keeps cards sharing a group at least 10 apart in catch-up, burying nothing', () => {
    const cards = [
      ...Array.from({ length: 30 }, (_, i) => warm(`x${i}`, { r: 0.5 + i / 100 })),
      warm('a', { r: 0.1, groups: ['item:a', 'k:日'] }),
      warm('b', { r: 0.11, groups: ['item:b', 'k:日'] }),
      warm('c', { r: 0.12, groups: ['item:c', 'k:日'] }),
    ];
    const { order, bury } = orderWarmup(cards, { yesterday: null, takenGroups: new Set(), catchUp: true });
    expect(bury).toEqual([]);
    expect(order).toHaveLength(33);
    const pos = ['a', 'b', 'c'].map((id) => order.indexOf(id));
    expect(pos[1] - pos[0]).toBeGreaterThanOrEqual(10);
    expect(pos[2] - pos[1]).toBeGreaterThanOrEqual(10);
  });

  it('batches sprint kana in fives, a rule alone, and everything else in fours with grammar last', () => {
    const plan = (kind: 'kana' | 'kanaRule' | 'kanji' | 'core' | 'grammar' | 'staged', n: number) =>
      ({ itemId: `${kind}:${n}`, kind, key: String(n), priceSec: 1, stream: 'kanji' as const });
    const batches = batchItems([...Array.from({ length: 7 }, (_, i) => plan('kana', i)), plan('kanaRule', 0)]);
    expect(batches.map((b) => b.items.length)).toEqual([5, 2, 1]);
    const mixed = batchItems([plan('grammar', 1), plan('core', 1), plan('kanji', 1), plan('staged', 1), plan('kanji', 2), plan('core', 2)]);
    expect(mixed.map((b) => b.items.map((i) => i.kind))).toEqual([['kanji', 'kanji', 'staged', 'core'], ['core', 'grammar']]);
  });

  it('starts the next study day at 4 a.m.', () => {
    expect(nextStudyDayStart(at(2026, 3, 20, 9))).toEqual(at(2026, 3, 21, 4));
    expect(nextStudyDayStart(at(2026, 3, 20, 2))).toEqual(at(2026, 3, 20, 4));
  });

  it('leaves the read block at least 3 minutes on days 15–60 at 25 min, and no fluency slot', () => {
    for (let day = 15; day <= 60; day++) {
      const strand = strandMinutes(day, 500, 25);
      expect(fluencySlotOpen(strand, 'normal', 2)).toBe(false);
      expect(strand - 1).toBeGreaterThanOrEqual(3);
    }
    expect(fluencySlotOpen(4, 'normal', 1)).toBe(false);
    expect(fluencySlotOpen(6, 'normal', 1)).toBe(true);
    expect(fluencySlotOpen(6, 'catch-up', 1)).toBe(false);
    expect(fluencySlotOpen(6, 'micro', 1)).toBe(false);
  });
});

describe('planToday', () => {
  it('buries a sibling until the next study day; startSitting is idempotent', async () => {
    await seedCourseDay(20);
    await addCard('kanji:日', 'write', { dueDaysAgo: 6 });
    await addCard('word:1002', 'read', { dueDaysAgo: 1 });
    const plan = await planToday(NOW);
    expect(plan.warmup).toEqual(['kanji:日|write']);
    expect(plan.bury).toEqual(['word:1002|read']);
    await startSitting(plan, NOW);
    const until = nextStudyDayStart(NOW);
    expect((await db.cards.get('word:1002|read'))?.due).toEqual(until);
    await startSitting(plan, new Date(NOW.getTime() + 60_000));
    expect((await db.cards.get('word:1002|read'))?.due).toEqual(until);
  });

  it('buries a card whose group was reviewed earlier today', async () => {
    await seedCourseDay(20);
    await addCard('kanji:日', 'write', { dueDaysAgo: 1 });
    await gradeCard('kanji:日|write', Rating.Good, { durationMs: 5000, mode: 'written', now: daysAgo(0, 7) });
    await addCard('word:1002', 'read', { dueDaysAgo: 1 });
    const plan = await planToday(NOW);
    expect(plan.warmup).toEqual([]);
    expect(plan.bury).toEqual(['word:1002|read']);
  });

  it('never puts New cards or cards of items introduced today in the warm-up; every New card is checked', async () => {
    await seedCourseDay(20);
    await addCard('core:cw-0040', 'listen', { introducedDaysAgo: 7, dueDaysAgo: -3 });
    await upgradeSpelling('cw-0040', daysAgo(0, 8));
    await addCard('word:1001', 'read', { introducedDaysAgo: 0, dueDaysAgo: 0, state: State.Learning });
    await addCard('grammar:wa-desu', 'comprehend', { introducedDaysAgo: 1, state: State.New });
    const plan = await planToday(NOW);
    expect(plan.warmup).toEqual([]);
    expect(plan.pendingCheck).toEqual(expect.arrayContaining(['core:cw-0040|read', 'grammar:wa-desu|comprehend']));
    expect(plan.pendingCheck).toHaveLength(2);
  });

  it('gives an anywhere sitting the whole warm-up, write cards included, and nothing else', async () => {
    await seedCourseDay(20);
    await addCard('kanji:日', 'write', { dueDaysAgo: 1 });
    await addCard('word:1004', 'read', { dueDaysAgo: 1 });
    await addCard('grammar:wa-desu', 'comprehend', { introducedDaysAgo: 1, state: State.New });
    const plan = await planToday(NOW, { sitting: 'anywhere' });
    expect(plan.warmup).toEqual(expect.arrayContaining(['kanji:日|write', 'word:1004|read']));
    expect(plan).toMatchObject({ paperAllowed: false, teach: [], pendingCheck: [], read: null, output: null, fluency: null });
  });

  it('after an anywhere sitting, a desk plan still has the unreviewed write cards plus teach, read, check and output', async () => {
    await seedCourseDay(20);
    fixtures.sentences = [{
      id: 's-1', jp: '{日本|にほん}', en: 'Japan', grammar: [], unit: 1, refs: ['word:1002'],
      tokens: [{ s: '日本', r: 'にほん', ref: 'word:1002', k: 'c' }],
    } satisfies SentenceEntry];
    await addCard('kanji:日', 'write', { dueDaysAgo: 1 });
    await addCard('word:1002', 'produce', { introducedDaysAgo: 3, dueDaysAgo: -5 });
    await addCard('grammar:wa-desu', 'comprehend', { introducedDaysAgo: 1, state: State.New });
    const anywhere = await planToday(NOW, { sitting: 'anywhere' });
    await startSitting(anywhere, NOW);
    const desk = await planToday(daysAgo(0, 19), { sitting: 'desk' });
    expect(desk.warmup).toContain('kanji:日|write');
    expect(desk.paperAllowed).toBe(true);
    expect(desk.teach.length).toBeGreaterThan(0);
    expect(desk.pendingCheck).toContain('grammar:wa-desu|comprehend');
    expect(desk.read?.sentences).toEqual([{ id: 's-1', target: 'word:1002' }]);
    expect(desk.output?.target.ref).toBe('word:1002');
  });

  it('teaches only what is not yet introduced in a later sitting; steps are recorded once', async () => {
    await seedCourseDay(20);
    const morning = await planToday(NOW);
    const firstBatch = morning.teach[0].items;
    for (const item of firstBatch) await introducePlanItem(item, NOW);
    const evening = await planToday(daysAgo(0, 19));
    const later = evening.teach.flatMap((b) => b.items.map((i) => i.itemId));
    for (const item of firstBatch) expect(later).not.toContain(item.itemId);
    expect(evening.partOfDayDone).toBe(true);

    await finishStep('read', NOW);
    await finishStep('read', NOW);
    expect((await getDay(TODAY)).steps).toEqual(['read']);
    expect((await planToday(NOW)).doneSteps).toEqual(['read']);
    expect((await planToday(NOW)).read).toBeNull();
  });

  it('in catch-up buries nothing, spaces siblings and shows no counts', async () => {
    await seedCourseDay(40);
    for (let i = 0; i < 120; i++) await addCard(`kanji:${String.fromCodePoint(0x5000 + i)}`, 'write', { dueDaysAgo: 3 + (i % 5) });
    await addCard('kanji:日', 'write', { dueDaysAgo: 20 });
    await addCard('word:1002', 'read', { dueDaysAgo: 20 });
    await addCard('word:1008', 'read', { dueDaysAgo: 20 });
    const plan = await planToday(NOW);
    expect(plan.mode).toBe('catch-up');
    expect(plan.counts).toBeUndefined();
    expect(plan.bury).toEqual([]);
    expect(plan.teach).toEqual([]);
    const pos = ['kanji:日|write', 'word:1002|read', 'word:1008|read'].map((id) => plan.warmup.indexOf(id)).filter((p) => p >= 0).sort((a, b) => a - b);
    expect(pos.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeGreaterThanOrEqual(10);
    await startSitting(plan, NOW);
    expect((await getDay(TODAY)).catchUp).toBe(true);
  });

  it('plans the normal day after missed days (the welcome-back is only on request)', async () => {
    await seedCourseDay(20);
    await db.days.bulkDelete([addDays(TODAY, -1), addDays(TODAY, -2), addDays(TODAY, -3)]);
    const plan = await planToday(NOW);
    expect(['normal', 'catch-up']).toContain(plan.mode);
  });

  it('gives the same plan when re-planned with nothing changed', async () => {
    await seedCourseDay(20);
    await addCard('kanji:日', 'write', { dueDaysAgo: 2 });
    await addCard('word:1004', 'read', { dueDaysAgo: 1 });
    expect(await planToday(NOW)).toEqual(await planToday(NOW));
  });

  it('estimates today and tomorrow in minutes', async () => {
    await seedCourseDay(20);
    const plan = await planToday(NOW);
    expect(plan.estimateMin).toBeGreaterThan(0);
    expect(plan.estimateMin).toBeLessThanOrEqual(28);
    expect(plan.tomorrowMin).toBeGreaterThan(0);
    expect(plan.counts?.newItems).toBe(plan.teach.reduce((s, b) => s + b.items.length, 0));
  });

  it('leaves the unused strand reserve out of the estimate once no read, output or fluency step is left', async () => {
    await seedCourseDay(20);
    fixtures.sentences = [{
      id: 's-1', jp: '{日本|にほん}', en: 'Japan', grammar: [], unit: 1, refs: ['word:1002'],
      tokens: [{ s: '日本', r: 'にほん', ref: 'word:1002', k: 'c' }],
    } satisfies SentenceEntry];
    await addCard('word:1002', 'produce', { introducedDaysAgo: 3, dueDaysAgo: -5 });
    // The morning sitting read for 90 s of the 4-minute reserve.
    await db.days.put({ ...emptyDay(TODAY), strandMs: 90_000 });
    const open = await planToday(daysAgo(0, 19));
    expect(open.warmup).toEqual([]);
    expect(open.read).not.toBeNull();
    expect(open.output).not.toBeNull();
    const newSec = open.teach.flatMap((b) => b.items).reduce((s, i) => s + i.priceSec, 0);
    // What the open steps take: one sentence (1 min) and the output (1 min), within the 150 s left of the reserve.
    expect(open.read?.minutes).toBe(1);
    expect(open.estimateMin).toBe(Math.ceil((newSec + 120) / 60));

    // Read done, output left: only the output's minute, not the rest of the reserve (QA V050).
    await finishStep('read', NOW);
    const outputLeft = await planToday(daysAgo(0, 19));
    expect(outputLeft).toMatchObject({ read: null, fluency: null });
    expect(outputLeft.output).not.toBeNull();
    expect(outputLeft.estimateMin).toBe(Math.ceil((newSec + 60) / 60));

    await finishStep('output', NOW);
    const done = await planToday(daysAgo(0, 19));
    expect(done).toMatchObject({ read: null, output: null, fluency: null });
    expect(done.estimateMin).toBe(Math.ceil(newSec / 60));
  });

  it('runs the sprint on day 1: two batches of five kana and the kana words', async () => {
    fixtures.kanaExamples = { あ: { kana: 'あい', en: 'love' }, か: { kana: 'かお', en: 'face' }, さ: { kana: 'さけ', en: 'salmon' } };
    const plan = await planToday(NOW);
    expect(plan.mode).toBe('sprint');
    expect(plan.courseDay).toBe(1);
    expect(plan.teach.map((b) => b.items.map((i) => i.key).join(''))).toEqual(['あいうえお', 'かきくけこ']);
    // 10 kana × 53 s, plus the read block's 1 minute (two words) of the 2-minute strand reserve.
    expect(plan.estimateMin).toBe(10);
    expect(plan.read?.kind).toBe('kana-words');
    expect(plan.read?.kanaWords.map((w) => w.ref)).toEqual(['kanaEx:あ', 'kanaEx:か']);
    expect(plan.output).toBeNull();
  });

  it('teaches the other script on day 1 right after a same-day placement check', async () => {
    fixtures.kanaExamples = {
      あ: { kana: 'あい', en: 'love' }, か: { kana: 'かお', en: 'face' }, さ: { kana: 'さけ', en: 'salmon' },
      た: { kana: 'たこ', en: 'octopus' }, な: { kana: 'なし', en: 'pear' }, は: { kana: 'はな', en: 'flower' },
      ま: { kana: 'まめ', en: 'bean' }, や: { kana: 'やま', en: 'mountain' }, ら: { kana: 'らく', en: 'ease' },
      ア: { kana: 'アイ', en: 'eye (loan)' }, カ: { kana: 'カオ', en: 'face (kana)' },
    };
    await applyPlacement('hiragana', 20, daysAgo(0, 8));
    const plan = await planToday(NOW);
    expect(plan.mode).toBe('sprint');
    const kana = plan.teach.flatMap((b) => b.items).filter((i) => i.kind === 'kana').map((i) => i.key);
    expect(kana.join('')).toBe('アイウエオカキクケコ');
    // The read block covers today's two katakana lessons (3 words each, today's kana first), not 46 more hiragana.
    expect(plan.read?.kanaWords).toHaveLength(6);
    expect(plan.read?.kanaWords.slice(0, 2).map((w) => w.ref)).toEqual(['kanaEx:ア', 'kanaEx:カ']);
  });
});

describe('micro and make-up plans', () => {
  it('plans 3 minutes of the most overdue non-write cards, nothing new', async () => {
    await seedCourseDay(20);
    for (let i = 0; i < 40; i++) await addCard(`word:${5000 + i}`, 'read', { dueDaysAgo: 1 + i });
    await addCard('kanji:日', 'write', { dueDaysAgo: 30 });
    const plan = await planMicro(NOW, { welcomeBack: true });
    expect(plan.mode).toBe('welcome-back');
    expect(plan.warmup).not.toContain('kanji:日|write');
    expect(plan.warmup.length).toBeGreaterThan(0);
    expect(plan.warmup[0]).toBe('word:5039|read');
    expect(plan.estimateMin * 60).toBeLessThanOrEqual(MICRO_SECONDS);
    expect(plan).toMatchObject({ teach: [], pendingCheck: [], read: null, output: null, fluency: null });
    expect((await planMicro(NOW)).mode).toBe('micro');
  });

  it('on a catch-up day shows no counts, and keeps the day in catch-up after the short sitting (V008)', async () => {
    await seedCourseDay(40);
    for (let i = 0; i < 120; i++) await addCard(`kanji:${String.fromCodePoint(0x5000 + i)}`, 'write', { dueDaysAgo: 3 + (i % 5) });
    for (let i = 0; i < 40; i++) await addCard(`word:${5000 + i}`, 'read', { dueDaysAgo: 1 + i });
    expect((await planToday(NOW)).mode).toBe('catch-up');
    const plan = await planMicro(NOW, { welcomeBack: true });
    expect(plan.mode).toBe('welcome-back');
    expect(plan.counts).toBeUndefined();
    await startSitting(plan, NOW);
    expect((await getDay(TODAY)).catchUp).toBe(true);
    expect((await planMicro(NOW)).counts).toBeUndefined();
  });

  it('counts the cards of a short sitting on a normal day, and leaves the day as it was', async () => {
    await seedCourseDay(20);
    await addCard('word:5000', 'read', { dueDaysAgo: 1 });
    const plan = await planMicro(NOW);
    expect(plan.counts).toEqual({ reviews: plan.warmup.length, newItems: 0 });
    await startSitting(plan, NOW);
    expect((await getDay(TODAY)).catchUp ?? false).toBe(false);
  });

  it('plans a make-up of review-ahead without today’s items', async () => {
    await seedCourseDay(20);
    await addCard('word:1004', 'read', { dueDaysAgo: -1 });
    await addCard('word:1005', 'read', { dueDaysAgo: -5 });
    await addCard('word:1001', 'read', { introducedDaysAgo: 0, dueDaysAgo: -1, state: State.Learning });
    const plan = await planMakeup(NOW);
    expect(plan.mode).toBe('makeup');
    expect(plan.warmup).toEqual(['word:1004|read']);
    expect(plan.estimateMin).toBe(10);
  });
});

describe('leakMask', () => {
  it('lists what is due before the rollover and not yet answered today', async () => {
    await seedCourseDay(20);
    await addCard('word:1002', 'read', { dueDaysAgo: 0 });
    await addCard('core:cw-0040', 'listen', { dueDaysAgo: -0.5 });
    await addCard('kanji:日', 'write', { dueDaysAgo: 1 });
    await addCard('word:1004', 'read', { dueDaysAgo: -3 });
    await addCard('word:1005', 'read', { dueDaysAgo: 1 });
    await gradeCard('word:1005|read', Rating.Good, { durationMs: 1000, mode: 'typed', now: daysAgo(0, 8) });
    // A produce card asks the word's kana (V039), even when it is due in another sitting the same day.
    await addCard('core:cw-0041', 'produce', { dueDaysAgo: -0.2 });
    const mask = await leakMask(NOW);
    expect([...mask.readings].sort()).toEqual(['core:cw-0041', 'word:1002']);
    expect([...mask.meanings]).toEqual(['core:cw-0040']);
    expect([...mask.kanji]).toEqual(['日']);
  });
});

describe('QA round 2: warm-up order, read block and estimates', () => {
  const warm = (id: string, patch: Partial<WarmupCard>): WarmupCard => ({
    id, itemId: id.slice(0, id.indexOf('|')), type: 'read', state: State.Review, r: 0.9, due: NOW, introducedDay: '2026-01-01',
    groups: [`item:${id.slice(0, id.indexOf('|'))}`], value: 0, ...patch,
  });
  const ROW = ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ'];

  it('does not replay chart order when cards tie, and keeps one order all day (QA V031)', () => {
    // Read cards reviewed together yesterday in chart order: r and due differ only by the seconds between answers.
    const reviews = ROW.map((c, i) => warm(`kana:${c}|read`, { r: 0.9 + i * 1e-6, due: new Date(NOW.getTime() - (60 - i) * 1000) }));
    const chart = reviews.map((c) => c.id);
    const opts = (seed: string) => ({ yesterday: null, takenGroups: new Set<string>(), catchUp: false, seed });
    const day3 = orderWarmup(reviews, opts('2026-03-20')).order;
    expect([...day3].sort()).toEqual([...chart].sort());
    expect(day3).not.toEqual(chart);
    expect(day3).not.toEqual([...chart].reverse());
    expect(orderWarmup(reviews, opts('2026-03-20')).order).toEqual(day3);
    expect(orderWarmup(reviews, opts('2026-03-21')).order).not.toEqual(day3);
    // Learning cards first-checked in chart order a few seconds apart: the same.
    const learning = reviews.map((c) => ({ ...c, state: State.Learning, introducedDay: '2026-03-19' }));
    expect(orderWarmup(learning, { ...opts('2026-03-20'), yesterday: '2026-03-19' }).order).not.toEqual(chart);
    // A real difference in retrievability still comes first.
    const weak = warm('kana:さ|read', { r: 0.5 });
    expect(orderWarmup([...reviews, weak], opts('2026-03-20')).order[0]).toBe('kana:さ|read');
  });

  it("reads a word for every kana taught today when the examples allow it (QA V032)", async () => {
    fixtures.kanaExamples = {
      あ: { kana: 'あい', en: 'love' }, い: { kana: 'いい', en: 'good' }, う: { kana: 'あう', en: 'to meet' },
      え: { kana: 'いえ', en: 'house' }, お: { kana: 'あお', en: 'blue' }, か: { kana: 'かお', en: 'face' },
      き: { kana: 'えき', en: 'station' }, く: { kana: 'いく', en: 'to go' }, け: { kana: 'いけ', en: 'pond' },
      こ: { kana: 'ここ', en: 'here' },
    };
    const plan = await planToday(NOW);
    const words = plan.read!.kanaWords.map((w) => w.kana);
    expect(words).toHaveLength(6);
    const read = new Set(words.flatMap((w) => [...w]));
    // Six two-kana words can read at most 9 of these 10 (う and こ each come in one word only); き, く and け were never read.
    expect(ROW.filter((c) => read.has(c))).toHaveLength(9);
    for (const c of ['き', 'く', 'け']) expect(read.has(c)).toBe(true);
  });

  /** Core word cw-NNNN with one listen card. */
  const coreId = (n: number) => `core:cw-${String(n).padStart(4, '0')}`;

  it('gives days 15–25 a 3-minute read & listen block of recent words when no sentence qualifies (QA V005, V054)', async () => {
    await seedCourseDay(18);
    for (let n = 1; n <= 14; n++) await addCard(coreId(n), 'listen', { introducedDaysAgo: 2 + (n % 5), dueDaysAgo: -3 });
    await addCard(coreId(15), 'listen', { introducedDaysAgo: 3, dueDaysAgo: 0 }); // due now: reviewed in the warm-up first
    await addCard(coreId(16), 'listen', { introducedDaysAgo: 3, dueDaysAgo: -3 });
    await addCard(coreId(16), 'produce', { introducedDaysAgo: 3, state: State.New }); // never checked: left out
    await addCard(coreId(17), 'listen', { introducedDaysAgo: 0, dueDaysAgo: -1, state: State.Learning }); // today's
    await addCard(coreId(42), 'listen', { introducedDaysAgo: 4, dueDaysAgo: -3 });
    await db.items.update(coreId(42), { spelledAt: daysAgo(2) }); // known spelled now: not a kana word
    const plan = await planToday(NOW);
    expect(plan.mode).toBe('normal');
    expect(plan.warmup).toContain(`${coreId(15)}|listen`);
    expect(plan.output).not.toBeNull();
    // Strand 4 min − 1 for the output = 3 minutes of words at 15 s.
    expect(plan.read).toMatchObject({ kind: 'kana-words', sentences: [], minutes: 3 });
    const refs = plan.read!.kanaWords.map((w) => w.ref);
    expect(refs).toHaveLength(12);
    expect(refs.every((r) => r.startsWith('core:'))).toBe(true);
    for (const id of [coreId(16), coreId(17), coreId(42)]) expect(refs).not.toContain(id);
    expect(plan.read!.kanaWords[0]).toMatchObject({ kana: expect.any(String), en: expect.any(String) });
  });

  it('fills the minutes one sentence leaves with words (QA V005)', async () => {
    await seedCourseDay(30);
    fixtures.sentences = [{
      id: 's-1', jp: '{日本|にほん}', en: 'Japan', grammar: [], unit: 1, refs: ['word:1002'],
      tokens: [{ s: '日本', r: 'にほん', ref: 'word:1002', k: 'c' }],
    } satisfies SentenceEntry];
    await addCard('word:1002', 'read', { introducedDaysAgo: 3, dueDaysAgo: -5 });
    for (let n = 1; n <= 10; n++) await addCard(coreId(n), 'listen', { introducedDaysAgo: 2 + (n % 6), dueDaysAgo: -4 });
    const plan = await planToday(NOW);
    expect(plan.read?.sentences).toEqual([{ id: 's-1', target: 'word:1002' }]);
    expect(plan.read?.kanaWords).toHaveLength(8);
    expect(plan.read?.minutes).toBe(3);
  });

  it("estimates tomorrow during the sprint from tomorrow's row and today's cards (QA V006, V029)", async () => {
    fixtures.kanaExamples = {
      あ: { kana: 'あい', en: 'love' }, い: { kana: 'いい', en: 'good' }, う: { kana: 'あう', en: 'to meet' },
      え: { kana: 'いえ', en: 'house' }, お: { kana: 'あお', en: 'blue' }, か: { kana: 'かお', en: 'face' },
      き: { kana: 'えき', en: 'station' }, く: { kana: 'いく', en: 'to go' }, け: { kana: 'いけ', en: 'pond' },
      こ: { kana: 'ここ', en: 'here' }, さ: { kana: 'さけ', en: 'salmon' }, し: { kana: 'しお', en: 'salt' },
      す: { kana: 'すし', en: 'sushi' }, せ: { kana: 'せき', en: 'seat' }, そ: { kana: 'そこ', en: 'there' },
      た: { kana: 'たこ', en: 'octopus' }, ち: { kana: 'ちかい', en: 'near' }, つ: { kana: 'つき', en: 'moon' },
      て: { kana: 'てき', en: 'enemy' }, と: { kana: 'とけい', en: 'clock' },
    };
    const day1 = await planToday(NOW);
    // Do day 1: both lessons, the first check, the read.
    for (const item of day1.teach.flatMap((b) => b.items)) await introducePlanItem(item, daysAgo(0, 9.2));
    for (const id of (await planToday(daysAgo(0, 9.4))).pendingCheck) {
      await gradeCard(id, Rating.Good, { durationMs: 5000, mode: 'typed', context: 'first-check', now: daysAgo(0, 9.5) });
    }
    await finishStep('read', daysAgo(0, 9.6));
    const day2 = await planToday(new Date(NOW.getTime() + DAY_MS));
    expect(day2.courseDay).toBe(2);
    expect(day2.teach.flatMap((b) => b.items).map((i) => i.key).join('')).toBe('さしすせそたちつてと');
    expect(day1.tomorrowMin).toBeGreaterThanOrEqual(12);
    expect(Math.abs(day1.tomorrowMin - day2.estimateMin)).toBeLessThanOrEqual(1);
  });

  it('estimates tomorrow as tomorrow will plan it, within the 1.1 × budget cap (QA V038)', async () => {
    await seedCourseDay(30);
    for (let i = 0; i < 40; i++) await addCard(`word:${7000 + i}`, 'read', { dueDaysAgo: -0.6 - (i % 3) * 0.1, stability: 6 });
    for (let n = 1; n <= 14; n++) await addCard(coreId(n), 'listen', { introducedDaysAgo: 3 + (n % 6), dueDaysAgo: -4 });
    const today = await planToday(NOW);
    expect(today.mode).toBe('normal');
    for (const item of today.teach.flatMap((b) => b.items)) await introducePlanItem(item, daysAgo(0, 9.2));
    for (const id of (await planToday(daysAgo(0, 9.4))).pendingCheck) {
      await gradeCard(id, Rating.Good, { durationMs: 5000, mode: 'typed', context: 'first-check', now: daysAgo(0, 9.5) });
    }
    await finishStep('read', daysAgo(0, 9.6));
    await finishStep('output', daysAgo(0, 9.6));
    const tomorrow = await planToday(new Date(NOW.getTime() + DAY_MS));
    expect(today.tomorrowMin).toBeLessThanOrEqual(27.5);
    expect(today.tomorrowMin).toBeLessThan(28);
    expect(Math.abs(today.tomorrowMin - tomorrow.estimateMin)).toBeLessThanOrEqual(2);
  });

  it('says reviews only for a travel day tomorrow (QA V006)', async () => {
    await seedCourseDay(30);
    await updateSettings({ travelUntil: addDays(TODAY, 1) });
    await addCard('word:1004', 'read', { dueDaysAgo: -0.5 });
    const plan = await planToday(NOW);
    expect(plan.mode).toBe('travel');
    expect(plan.tomorrowMin).toBe(1);
  });

  it('counts staged releases today by row, whatever their price (QA V041)', async () => {
    await seedCourseDay(20);
    await db.items.put({ id: 'kanji:本', kind: 'kanji', key: '本', introducedAt: daysAgo(8), via: 'lesson' });
    await db.staged.bulkPut([
      { itemId: 'core:cw-0042', kanji: '本', releaseDay: addDays(TODAY, -2), slot: 2 },
      { itemId: 'word:1006', kanji: '本', releaseDay: addDays(TODAY, -1), slot: 2 },
      { itemId: 'word:1008', kanji: '本', releaseDay: addDays(TODAY, -1), slot: 3 },
      { itemId: 'word:1002', kanji: '日', releaseDay: TODAY, slot: 2 },
      { itemId: 'word:1005', kanji: '末', releaseDay: TODAY, slot: 3 },
    ]);
    const morning = await planToday(NOW);
    const staged = morning.teach.flatMap((b) => b.items).filter((i) => i.kind === 'staged');
    expect(staged.map((i) => [i.itemId, i.priceSec])).toEqual([['core:cw-0042', 47], ['word:1006', 28], ['word:1008', 28], ['word:1002', 28]]);
    await introducePlanItem(staged[0], daysAgo(0, 9.2));
    // 47 s were spent on one release: three more fit the ceiling of 4 (47 / 28 would have counted two).
    const later = await planToday(daysAgo(0, 19));
    expect(later.teach.flatMap((b) => b.items).filter((i) => i.kind === 'staged').map((i) => i.itemId)).toEqual(['word:1006', 'word:1008', 'word:1002']);
  });
});
