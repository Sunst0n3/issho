import { State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import type { GrammarPoint, StagedWordRecord } from '../lib/types.ts';
import {
  applyPlacement,
  buildSnapshot,
  componentMap,
  courseDay,
  courseDayFrom,
  courseGates,
  courseProgress,
  currentUnit,
  introducePlanItem,
  kanaSprint,
  loadCourseSnapshot,
  nextUnits,
  placementSet,
  sprintPick,
  streamCandidates,
  studyDaysApart,
  taughtKana,
  type CourseData,
  type KnownScripts,
  type NewItemPlan,
} from './course.ts';
import { addDays, getDay, updateDay } from './days.ts';
import { seededRandom } from './random.ts';
import { at, BASIC_HIRAGANA, BASIC_KATAKANA, CORE, CURRICULUM, GRAMMAR, KANA, resetDb, RULES } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const DATA: CourseData = { kana: KANA, rules: RULES, curriculum: CURRICULUM, core: CORE, grammar: GRAMMAR };
const START = '2026-01-05';
/** Study days 1..n − 1 before course day n (consecutive calendar days from START). */
const studyDaysFor = (courseDayN: number) => Array.from({ length: courseDayN - 1 }, (_, i) => addDays(START, i));
const todayFor = (courseDayN: number) => addDays(START, courseDayN - 1);

function snapshot(courseDayN: number, introduced: Iterable<[string, string]>, patch: { known?: KnownScripts; staged?: StagedWordRecord[]; travel?: boolean; data?: CourseData } = {}) {
  return buildSnapshot(patch.data ?? DATA, {
    today: todayFor(courseDayN),
    known: patch.known ?? {},
    introduced: new Map(introduced),
    studyDays: studyDaysFor(courseDayN),
    staged: patch.staged ?? [],
    travel: patch.travel ?? false,
  });
}

/** Every sprint item introduced on `day`. */
const wholeSprint = (day: string): [string, string][] => [
  ...[...BASIC_HIRAGANA, ...BASIC_KATAKANA].map((c): [string, string] => [`kana:${c}`, day]),
  ...RULES.map((r): [string, string] => [`kanaRule:${r.id}`, day]),
];

describe('kanaSprint', () => {
  it('runs 14 days when neither script is known', () => {
    const sprint = kanaSprint(KANA, RULES, {});
    expect(sprint.map((d) => d.day)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(sprint[0].kana.join('')).toBe('あいうえおかきくけこ');
    expect(sprint[4].kana.join('')).toBe('らりるれろわをん');
    expect(sprint.slice(0, 5).flatMap((d) => d.kana)).toHaveLength(46);
    expect(sprint.map((d) => d.rule ?? null)).toEqual([
      null, null, null, null, null, 'hira-dakuten', 'hira-yoon', null, null, null, null, null, 'kata-dakuten-yoon', 'kata-extended',
    ]);
    expect(sprint.slice(7, 12).flatMap((d) => d.kana)).toEqual(BASIC_KATAKANA);
    expect(sprint.filter((d) => d.kanaCheck).map((d) => d.day)).toEqual([14]);
  });

  it('moves katakana to days 1–7 when hiragana is known, and is empty when both are', () => {
    const sprint = kanaSprint(KANA, RULES, { hiragana: true });
    expect(sprint.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sprint.every((d) => d.script === 'katakana')).toBe(true);
    expect(sprint[0].kana.join('')).toBe('アイウエオカキクケコ');
    expect(sprint[6]).toMatchObject({ rule: 'kata-extended', kanaCheck: true });
    expect(kanaSprint(KANA, RULES, { hiragana: true, katakana: true })).toEqual([]);
    expect(kanaSprint(KANA, RULES, { katakana: true }).map((d) => d.script)).toEqual(Array(7).fill('hiragana'));
  });
});

describe('courseGates', () => {
  it('sets the stream gates by what placement found', () => {
    expect(courseGates({})).toEqual({ coreFrom: 3, grammarFrom: 8, kanjiFrom: 15, governorFrom: 15 });
    expect(courseGates({ hiragana: true })).toEqual({ coreFrom: 1, grammarFrom: 1, kanjiFrom: 8, governorFrom: 8 });
    expect(courseGates({ katakana: true })).toEqual({ coreFrom: 3, grammarFrom: 8, kanjiFrom: 8, governorFrom: 8 });
    expect(courseGates({ hiragana: true, katakana: true })).toEqual({ coreFrom: 1, grammarFrom: 1, kanjiFrom: 1, governorFrom: 1 });
  });
});

describe('sprintPick', () => {
  const sprint = kanaSprint(KANA, RULES, {});

  it('teaches a row missed on a review-only day first, then catches up', () => {
    // Day 2 after a day 1 with only reviews: day 1's あ and か rows.
    const day2 = sprintPick(sprint, new Map(), todayFor(2), 2);
    expect(day2.kana.join('')).toBe('あいうえおかきくけこ');
    expect(day2.rule).toBeNull();
    // Day 3 then teaches day 2's rows.
    const taught = new Map(day2.kana.map((c): [string, string] => [`kana:${c}`, todayFor(2)]));
    expect(sprintPick(sprint, taught, todayFor(3), 3).kana.join('')).toBe('さしすせそたちつてと');
  });

  it('teaches at most 10 kana a day, counting earlier sittings', () => {
    expect(sprintPick(sprint, new Map(), todayFor(5), 5).kana).toHaveLength(10);
    const earlier = new Map(BASIC_HIRAGANA.slice(0, 4).map((c): [string, string] => [`kana:${c}`, todayFor(5)]));
    expect(sprintPick(sprint, earlier, todayFor(5), 5).kana).toHaveLength(6);
  });

  it('teaches a rule only after its script rows, and at most one a day', () => {
    const allButLast = new Map(BASIC_HIRAGANA.slice(0, 30).map((c): [string, string] => [`kana:${c}`, todayFor(5)]));
    // 16 untaught kana: 10 fill the day and 6 are left, so the rule waits.
    expect(sprintPick(sprint, allButLast, todayFor(6), 6)).toMatchObject({ rule: null });
    const fewLeft = new Map(BASIC_HIRAGANA.slice(0, 40).map((c): [string, string] => [`kana:${c}`, todayFor(5)]));
    // The last 6 are in today's pick, so the rule comes after them.
    expect(sprintPick(sprint, fewLeft, todayFor(6), 6)).toMatchObject({ rule: 'hira-dakuten' });
    expect(sprintPick(sprint, fewLeft, todayFor(6), 6).kana).toHaveLength(6);
    const allHira = new Map(BASIC_HIRAGANA.map((c): [string, string] => [`kana:${c}`, todayFor(5)]));
    expect(sprintPick(sprint, allHira, todayFor(7), 7).rule).toBe('hira-dakuten');
    allHira.set('kanaRule:hira-dakuten', todayFor(7));
    expect(sprintPick(sprint, allHira, todayFor(7), 7).rule).toBeNull();
    expect(sprintPick(sprint, allHira, todayFor(8), 8).rule).toBe('hira-yoon');
  });

  it('does not count a same-day placement of the known script against the day', () => {
    // Onboarding passed the hiragana check this morning: its 46 kana and 2 rules were introduced today.
    const katakanaSprint = kanaSprint(KANA, RULES, { hiragana: true });
    const placed = new Map<string, string>([
      ...BASIC_HIRAGANA.map((c): [string, string] => [`kana:${c}`, todayFor(1)]),
      ['kanaRule:hira-dakuten', todayFor(1)],
      ['kanaRule:hira-yoon', todayFor(1)],
    ]);
    const day1 = sprintPick(katakanaSprint, placed, todayFor(1), 1);
    expect(day1.kana.join('')).toBe('アイウエオカキクケコ');
    // The katakana rule still waits for its own rows, and today's placement rules do not block it later.
    const allKata = new Map([...placed, ...BASIC_KATAKANA.map((c): [string, string] => [`kana:${c}`, todayFor(1)])]);
    expect(sprintPick(katakanaSprint, allKata, todayFor(1), 6).rule).toBe('kata-dakuten-yoon');
    expect(streamCandidates(snapshot(1, placed, { known: { hiragana: true } })).kana).toHaveLength(10);
  });
});

describe('course day', () => {
  it('counts distinct study days before today', () => {
    expect(courseDayFrom([], '2026-01-05')).toBe(1);
    expect(courseDayFrom(['2026-01-05', '2026-01-05', '2026-01-07'], '2026-01-08')).toBe(3);
    expect(courseDayFrom(['2026-01-05', '2026-01-09'], '2026-01-08')).toBe(2);
  });

  it('counts study days apart by their index distance', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'];
    expect(studyDaysApart('2026-01-01', '2026-01-06', days)).toBe(4);
    expect(studyDaysApart('2026-01-06', '2026-01-06', days)).toBe(0);
  });

  it('reads the study days from the DayRecords', async () => {
    await updateDay('2026-01-05', (d) => {
      d.reviews = 3;
    });
    await updateDay('2026-01-06', (d) => {
      d.travel = true;
    });
    await updateDay('2026-01-07', (d) => {
      d.minimumDone = true;
    });
    expect(await courseDay(at(2026, 1, 8, 9))).toBe(3);
    expect(await courseDay(at(2026, 1, 8, 3))).toBe(2); // before 4 a.m. it is still the 7th
  });
});

describe('streamCandidates', () => {
  it('gates core words from day 3 and grammar from day 8 during the sprint', () => {
    expect(streamCandidates(snapshot(2, [])).core).toEqual([]);
    expect(streamCandidates(snapshot(3, [])).core.map((c) => c.key)).toEqual(['cw-0001', 'cw-0002', 'cw-0003']);
    expect(streamCandidates(snapshot(7, [])).grammar).toBeNull();
    expect(streamCandidates(snapshot(8, [])).grammar?.key).toBe('wa-desu');
  });

  it('offers no kanji on day 15 while a sprint row is untaught, and does once it is taught', () => {
    const missing = wholeSprint(todayFor(13)).filter(([id]) => id !== 'kana:ン');
    const s = snapshot(15, missing);
    expect(s.sprintComplete).toBe(false);
    expect(streamCandidates(s).kanji).toEqual([]);
    expect(streamCandidates(s).kana.map((k) => k.key)).toEqual(['ン']);
    expect(streamCandidates(snapshot(15, wholeSprint(todayFor(13)))).kanji.length).toBeGreaterThan(0);
  });

  it('keeps the sprint display rules on the day the sprint completes, not the next', () => {
    expect(snapshot(14, wholeSprint(todayFor(14))).inSprint).toBe(true);
    expect(snapshot(15, wholeSprint(todayFor(14))).inSprint).toBe(false);
    expect(snapshot(10, []).inSprint).toBe(true);
    const known = snapshot(1, [], { known: { hiragana: true, katakana: true } });
    expect(known.sprintComplete).toBe(true);
    expect(known.inSprint).toBe(false);
  });

  it('prices kanji with an anchor at 188 s and zero-word kanji at 160 s', () => {
    const before = wholeSprint(todayFor(1));
    const done = (chars: string[]) => chars.map((c): [string, string] => [`kanji:${c}`, todayFor(1)]);
    const s = snapshot(20, [...before, ...done(['一', '二', '三', '四', '五', '日', '元', '気', '未', '末', '本'])]);
    const kanji = streamCandidates(s).kanji;
    expect(kanji.map((k) => [k.key, k.priceSec, k.anchor])).toEqual([['乙', 160, null], ['人', 188, 'word:1007']]);
  });

  it('defers a visual look-alike introduced fewer than 5 study days ago', () => {
    const sprintDone = wholeSprint(todayFor(1));
    const firstEight = ['一', '二', '三', '四', '五', '日', '元', '気'].map((c): [string, string] => [`kanji:${c}`, todayFor(1)]);
    const fourAgo: [string, string] = ['kanji:未', todayFor(16)];
    const fiveAgo: [string, string] = ['kanji:未', todayFor(15)];
    expect(streamCandidates(snapshot(20, [...sprintDone, ...firstEight, fourAgo])).kanji.map((k) => k.key)).toEqual(['本', '乙', '人']);
    expect(streamCandidates(snapshot(20, [...sprintDone, ...firstEight, fiveAgo])).kanji.map((k) => k.key)).toEqual(['末', '本', '乙', '人']);
  });

  it('holds back a kanji whose component waits behind a look-alike (国 never before 玉)', () => {
    const sprintDone = wholeSprint(todayFor(1));
    const firstEight = ['一', '二', '三', '四', '五', '日', '元', '気'].map((c): [string, string] => [`kanji:${c}`, todayFor(1)]);
    const fourAgo: [string, string] = ['kanji:未', todayFor(16)];
    // 本 is built on 末 here (a test stand-in); 乙's part 乚 is not a curriculum kanji and never holds it back.
    const data: CourseData = { ...DATA, components: new Map([['本', ['末']], ['乙', ['乚']]]) };
    expect(streamCandidates(snapshot(20, [...sprintDone, ...firstEight, fourAgo], { data })).kanji.map((k) => k.key)).toEqual(['乙', '人']);
    // Once 末 can come, it comes first and 本 may follow it in the same batch.
    const fiveAgo: [string, string] = ['kanji:未', todayFor(15)];
    expect(streamCandidates(snapshot(20, [...sprintDone, ...firstEight, fiveAgo], { data })).kanji.map((k) => k.key)).toEqual(['末', '本', '乙', '人']);
    expect(componentMap({ 本: { components: ['末'] }, 末: { components: [] } })).toEqual(new Map([['本', ['末']]]));
  });

  it('allows at most 3 numbers a day, counting an earlier sitting', () => {
    const sprintDone = wholeSprint(todayFor(1));
    expect(streamCandidates(snapshot(20, sprintDone)).kanji.map((k) => k.key)).toEqual(['一', '二', '三', '日']);
    const morning: [string, string][] = [['kanji:一', todayFor(20)], ['kanji:二', todayFor(20)]];
    expect(streamCandidates(snapshot(20, [...sprintDone, ...morning])).kanji.map((k) => k.key)).toEqual(['三', '日', '元', '気']);
  });

  it('keeps は and が at least 5 study days apart', () => {
    const base: [string, string][] = [
      ...wholeSprint(todayFor(1)),
      ['grammar:ka-question', todayFor(2)],
      ['grammar:no-possession', todayFor(4)],
      ['grammar:mo-also', todayFor(6)],
    ];
    const fourAgo = streamCandidates(snapshot(20, [...base, ['grammar:wa-desu', todayFor(16)]]));
    expect(fourAgo.grammar?.key).toBe('numbers-prices');
    const fiveAgo = streamCandidates(snapshot(20, [...base, ['grammar:wa-desu', todayFor(15)]]));
    expect(fiveAgo.grammar?.key).toBe('ga-subject');
  });

  it('skips a point whose prerequisite is not taught, and allows grammar every second study day only', () => {
    const grammar: GrammarPoint[] = [
      { ...GRAMMAR[0], id: 'g1', order: 1, prerequisites: [], contrastWith: [] },
      { ...GRAMMAR[0], id: 'g2', order: 2, prerequisites: ['g9'], contrastWith: [] },
      { ...GRAMMAR[0], id: 'g3', order: 3, prerequisites: ['g1'], contrastWith: [] },
      { ...GRAMMAR[0], id: 'g9', order: 9, prerequisites: [], contrastWith: [] },
    ];
    const data = { ...DATA, grammar };
    expect(streamCandidates(snapshot(20, [['grammar:g1', todayFor(10)]], { data })).grammar?.key).toBe('g3');
    // g1 was taught on the previous study day: no grammar today.
    expect(streamCandidates(snapshot(20, [['grammar:g1', todayFor(19)]], { data })).grammar).toBeNull();
    expect(streamCandidates(snapshot(20, [['grammar:g1', todayFor(20)]], { data })).grammar).toBeNull();
  });

  it('flags the weekly grammar floor', () => {
    // 2026-01-05 is a Monday: course day 20 is Saturday 2026-01-24, its week began on the 19th.
    const one: [string, string][] = [...wholeSprint(todayFor(1)), ['grammar:wa-desu', '2026-01-19']];
    expect(streamCandidates(snapshot(20, one)).grammarBelowFloor).toBe(true);
    const two: [string, string][] = [...one, ['grammar:ka-question', '2026-01-21']];
    expect(streamCandidates(snapshot(20, two)).grammarBelowFloor).toBe(false);
  });

  it('plans no kanji and no grammar while travelling', () => {
    const s = snapshot(20, wholeSprint(todayFor(1)), { travel: true });
    expect(streamCandidates(s).kanji).toEqual([]);
    expect(streamCandidates(s).grammar).toBeNull();
  });

  it('releases due staged words, oldest first, at most 4', () => {
    const rows: StagedWordRecord[] = Array.from({ length: 6 }, (_, i) => ({
      itemId: `word:${3000 + i}`, kanji: '日', releaseDay: todayFor(20 - i), slot: 2,
    }));
    rows.push({ itemId: 'word:4000', kanji: '日', releaseDay: todayFor(21), slot: 3 });
    rows.push({ itemId: 'core:cw-0040', kanji: '元', releaseDay: todayFor(10), slot: 2, releasedAt: at(2026, 1, 14) });
    const staged = streamCandidates(snapshot(20, wholeSprint(todayFor(1)), { staged: rows })).staged;
    expect(staged.map((s) => s.itemId)).toEqual(['word:3005', 'word:3004', 'word:3003', 'word:3002']);
    expect(staged[0]).toMatchObject({ kind: 'staged', stream: 'staged', priceSec: 28, kanji: '日', key: '3005' });
  });
});

describe('introducePlanItem', () => {
  const NOW = at(2026, 1, 20, 9);

  it('introduces a kanji with its anchor and stages its later words +3 and +8 calendar days', async () => {
    const plan: NewItemPlan = { itemId: 'kanji:日', kind: 'kanji', key: '日', anchor: 'word:1001', priceSec: 188, stream: 'kanji' };
    const results = await introducePlanItem(plan, NOW);
    expect(results.map((r) => r.item.id)).toEqual(['kanji:日', 'word:1001']);
    expect(results[0].cards.map((c) => c.type)).toEqual(['write']);
    expect(results[1].cards.map((c) => c.type)).toEqual(['read']);
    expect(await db.staged.toArray()).toEqual([
      { itemId: 'word:1002', kanji: '日', releaseDay: '2026-01-23', slot: 2 },
      { itemId: 'word:1008', kanji: '日', releaseDay: '2026-01-28', slot: 3 },
    ]);
    const day = await getDay('2026-01-20');
    expect(day.newItems).toBe(1);
    expect(day.newSec.kanji).toBe(188);
  });

  it('is idempotent: a second call creates nothing and counts nothing', async () => {
    const plan: NewItemPlan = { itemId: 'kanji:日', kind: 'kanji', key: '日', anchor: 'word:1001', priceSec: 188, stream: 'kanji' };
    await introducePlanItem(plan, NOW);
    const again = await introducePlanItem(plan, new Date(NOW.getTime() + 60_000));
    expect(again[0].created).toBe(false);
    expect(await db.items.count()).toBe(2);
    expect(await db.staged.count()).toBe(2);
    const day = await getDay('2026-01-20');
    expect(day.newItems).toBe(1);
    expect(day.newSec.kanji).toBe(188);
  });

  it("gives a zero-word kanji a meaning card", async () => {
    const [kanji] = await introducePlanItem({ itemId: 'kanji:乙', kind: 'kanji', key: '乙', anchor: null, priceSec: 160, stream: 'kanji' }, NOW);
    expect(kanji.cards.map((c) => c.type)).toEqual(['write', 'meaning']);
  });

  it("merges a core anchor already known: 元気's kanji adds exactly one card, the read card", async () => {
    const [word] = await introducePlanItem({ itemId: 'core:cw-0040', kind: 'core', key: 'cw-0040', priceSec: 35, stream: 'core' }, at(2026, 1, 10));
    expect(word.cards.map((c) => c.type)).toEqual(['listen', 'produce']);
    const before = await db.cards.count();
    const results = await introducePlanItem({ itemId: 'kanji:元', kind: 'kanji', key: '元', anchor: 'core:cw-0040', priceSec: 188, stream: 'kanji' }, NOW);
    expect(results[1].cards.map((c) => c.id)).toEqual(['core:cw-0040|read']);
    expect(await db.cards.where('itemId').equals('core:cw-0040').count()).toBe(3);
    expect(await db.cards.count()).toBe(before + 2); // the kanji's write card + the word's read card
    expect(await db.items.where('kind').equals('core').count()).toBe(1);
    expect((await db.items.get('core:cw-0040'))?.spelledAt).toEqual(NOW);
  });

  it('introduces a core anchor not yet known with listen, produce and read', async () => {
    const results = await introducePlanItem({ itemId: 'kanji:元', kind: 'kanji', key: '元', anchor: 'core:cw-0040', priceSec: 188, stream: 'kanji' }, NOW);
    expect(results[1].cards.map((c) => c.type)).toEqual(['listen', 'produce', 'read']);
  });

  it('spells a core word with kanji once all its kanji are introduced', async () => {
    await introducePlanItem({ itemId: 'kanji:人', kind: 'kanji', key: '人', anchor: 'word:1007', priceSec: 188, stream: 'kanji' }, NOW);
    const [word] = await introducePlanItem({ itemId: 'core:cw-0044', kind: 'core', key: 'cw-0044', priceSec: 35, stream: 'core' }, NOW);
    expect(word.cards.map((c) => c.type)).toEqual(['listen', 'produce', 'read']);
    const [kanaOnly] = await introducePlanItem({ itemId: 'core:cw-0042', kind: 'core', key: 'cw-0042', priceSec: 35, stream: 'core' }, NOW);
    expect(kanaOnly.cards.map((c) => c.type)).toEqual(['listen', 'produce']);
  });

  it('settles a pending staged row when the core stream teaches the word with its spelling first', async () => {
    await introducePlanItem({ itemId: 'kanji:人', kind: 'kanji', key: '人', anchor: 'word:1007', priceSec: 188, stream: 'kanji' }, NOW);
    await db.staged.bulkPut([
      { itemId: 'core:cw-0044', kanji: '人', releaseDay: '2026-01-25', slot: 2 },
      { itemId: 'core:cw-0040', kanji: '元', releaseDay: '2026-01-25', slot: 2 },
    ]);
    await introducePlanItem({ itemId: 'core:cw-0044', kind: 'core', key: 'cw-0044', priceSec: 35, stream: 'core' }, NOW);
    expect((await db.staged.get('core:cw-0044'))?.releasedAt).toEqual(NOW);
    // Taught in kana (元 and 気 not introduced): its release still has the read card to add.
    await introducePlanItem({ itemId: 'core:cw-0040', kind: 'core', key: 'cw-0040', priceSec: 35, stream: 'core' }, NOW);
    expect((await db.staged.get('core:cw-0040'))?.releasedAt).toBeUndefined();
  });

  it('releases a staged word (a spelling upgrade counts its price but not as a new item)', async () => {
    await db.staged.bulkPut([
      { itemId: 'word:1002', kanji: '日', releaseDay: '2026-01-20', slot: 2 },
      { itemId: 'core:cw-0040', kanji: '元', releaseDay: '2026-01-20', slot: 2 },
    ]);
    await introducePlanItem({ itemId: 'core:cw-0040', kind: 'core', key: 'cw-0040', priceSec: 35, stream: 'core' }, at(2026, 1, 10));
    const [released] = await introducePlanItem({ itemId: 'word:1002', kind: 'staged', key: '1002', kanji: '日', priceSec: 28, stream: 'staged' }, NOW);
    expect(released.item.via).toBe('staged');
    expect(released.cards.map((c) => c.type)).toEqual(['read', 'produce']);
    const [upgrade] = await introducePlanItem({ itemId: 'core:cw-0040', kind: 'staged', key: 'cw-0040', kanji: '元', upgrade: true, priceSec: 28, stream: 'staged' }, NOW);
    expect(upgrade.cards.map((c) => c.id)).toEqual(['core:cw-0040|read']);
    expect((await db.staged.get('word:1002'))?.releasedAt).toEqual(NOW);
    const day = await getDay('2026-01-20');
    expect(day.newItems).toBe(1);
    expect(day.newSec.staged).toBe(56);
  });

  it('introduces grammar with comprehend and build, or comprehend only for recognition', async () => {
    const [point] = await introducePlanItem({ itemId: 'grammar:wa-desu', kind: 'grammar', key: 'wa-desu', priceSec: 200, stream: 'grammar' }, NOW);
    expect(point.cards.map((c) => c.type)).toEqual(['comprehend', 'build']);
    const [passive] = await introducePlanItem({ itemId: 'grammar:passive', kind: 'grammar', key: 'passive', priceSec: 200, stream: 'grammar' }, NOW);
    expect(passive.cards.map((c) => c.type)).toEqual(['comprehend']);
  });

  it('counts sprint items under the sprint stream', async () => {
    await introducePlanItem({ itemId: 'kana:あ', kind: 'kana', key: 'あ', priceSec: 53, stream: 'sprint' }, NOW);
    await introducePlanItem({ itemId: 'kanaRule:hira-dakuten', kind: 'kanaRule', key: 'hira-dakuten', priceSec: 150, stream: 'sprint' }, NOW);
    const day = await getDay('2026-01-20');
    expect(day.newSec.sprint).toBe(203);
    expect(day.newItems).toBe(2);
    expect((await db.cards.where('itemId').equals('kana:あ').toArray()).map((c) => c.type).sort()).toEqual(['read', 'write']);
  });
});

describe('placement', () => {
  it('draws 20 basic kana of the script', () => {
    const set = placementSet(KANA, 'katakana', seededRandom(1));
    expect(set).toHaveLength(20);
    expect(set.every((k) => k.script === 'katakana' && k.kind === 'basic')).toBe(true);
    expect(new Set(set.map((k) => k.char)).size).toBe(20);
  });

  it('18 of 20 puts the script in Review; 17 starts the sprint', async () => {
    const NOW = at(2026, 1, 5, 9);
    expect(await applyPlacement('hiragana', 17, NOW)).toBe('sprint');
    expect(await db.items.count()).toBe(0);
    expect((await getSettings()).knowsHiragana).toBe(false);

    expect(await applyPlacement('hiragana', 18, NOW)).toBe('known');
    const kanaCards = await db.cards.where('kind').equals('kana').toArray();
    expect(kanaCards).toHaveLength(92);
    expect(kanaCards.every((c) => c.state === State.Review && c.stability === 10)).toBe(true);
    const dueDays = kanaCards.map((c) => Math.round((c.due.getTime() - NOW.getTime()) / 86_400_000));
    expect(Math.min(...dueDays)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...dueDays)).toBeLessThanOrEqual(10);
    expect((await db.items.where('kind').equals('kanaRule').toArray()).map((i) => i.key).sort()).toEqual(['hira-dakuten', 'hira-yoon']);
    expect((await db.items.get('kana:あ'))?.via).toBe('placement');
    expect((await getSettings()).knowsHiragana).toBe(true);
    // Placement creates no study day.
    expect(await courseDay(NOW)).toBe(1);
  });
});

describe('snapshot and progress from the database', () => {
  it('builds the snapshot from settings, items, days and staged rows', async () => {
    await updateSettings({ knowsHiragana: true, travelUntil: '2026-02-01' });
    await updateDay('2026-01-05', (d) => {
      d.reviews = 1;
    });
    const s = await loadCourseSnapshot(at(2026, 1, 6, 9));
    expect(s.courseDay).toBe(2);
    expect(s.known).toEqual({ hiragana: true, katakana: false });
    expect(s.sprint).toHaveLength(7);
    expect(s.travel).toBe(true);
    expect(s.studyDays).toEqual(['2026-01-05']);
  });

  it('reports course progress, the current unit, next units and the taught kana', async () => {
    await introducePlanItem({ itemId: 'kana:あ', kind: 'kana', key: 'あ', priceSec: 53, stream: 'sprint' }, at(2026, 1, 5, 9));
    await introducePlanItem({ itemId: 'kanaRule:hira-dakuten', kind: 'kanaRule', key: 'hira-dakuten', priceSec: 150, stream: 'sprint' }, at(2026, 1, 5, 9));
    await introducePlanItem({ itemId: 'grammar:wa-desu', kind: 'grammar', key: 'wa-desu', priceSec: 200, stream: 'grammar' }, at(2026, 1, 5, 9));
    const progress = await courseProgress(at(2026, 1, 6, 9));
    expect(progress).toMatchObject({ kanaIntroduced: 1, kanaTotal: 92, grammarIntroduced: 1, kanjiTotal: CURRICULUM.units.length, sprintDone: false, courseComplete: false });
    expect(await currentUnit()).toBe(1);
    expect((await nextUnits(2)).map((u) => u.char)).toEqual(['一', '二']);
    const taught = await taughtKana();
    expect(taught.has('あ')).toBe(true);
    expect(taught.has('が')).toBe(true);
    expect(taught.has('か')).toBe(false);
  });
});
