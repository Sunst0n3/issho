import { State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, itemId, updateSettings } from '../lib/db.ts';
import {
  applyKnownKana,
  courseProgress,
  currentPhase,
  grammarDueToday,
  introducePlanItem,
  nextNewItems,
  nextUnits,
  orderKanaCourse,
  phaseFor,
  planNewItems,
  requiredKana,
  SURVIVAL_WORDS_PER_DAY,
  upcomingUnits,
  type CourseSnapshot,
  type NewItemPlan,
} from './course.ts';
import { introduceItem, markKnownMany } from './items.ts';
import { shuffle, seededRandom } from './random.ts';
import { at, BASIC_HIRAGANA, CURRICULUM, fixtures, G_WA_KANA, GRAMMAR, KANA, resetDb, SURVIVAL } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const kanaIds = (chars: Iterable<string>) => [...chars].map((c) => itemId('kana', c));
const ALL_KANA = kanaIds(KANA.map((k) => k.char));
const BASIC_KANA = kanaIds(KANA.filter((k) => k.kind === 'basic').map((k) => k.char));
const UNITS = CURRICULUM.units.map((u) => itemId(u.type, u.char));

function snapshot(patch: Partial<CourseSnapshot> = {}): CourseSnapshot {
  return {
    kana: KANA,
    curriculum: CURRICULUM,
    survival: SURVIVAL,
    grammar: GRAMMAR,
    introduced: new Set(),
    knowsHiragana: false,
    knowsKatakana: false,
    grammarDue: false,
    vocabToday: 0,
    ...patch,
  };
}

const keys = (plan: { key: string }[]) => plan.map((p) => p.key);
const grammarIn = (plan: NewItemPlan[]) => keys(plan.filter((p) => p.kind === 'grammar'));

describe('orderKanaCourse', () => {
  it('teaches hiragana basic → dakuten → yōon, then katakana the same way', () => {
    const ordered = orderKanaCourse(shuffle(KANA, seededRandom(7)));
    expect(ordered.map((k) => k.char).join('')).toBe('あいうえおかきくけこんがごきゃアイウエオカキクケコンガキャ');
  });

  it('leaves out scripts the learner already knows', () => {
    expect(orderKanaCourse(KANA, { hiragana: true }).every((k) => k.script === 'katakana')).toBe(true);
    expect(orderKanaCourse(KANA, { hiragana: true, katakana: true })).toEqual([]);
  });
});

describe('requiredKana', () => {
  const course = new Set(KANA.map((k) => k.char));
  it('counts yōon as one unit and ignores っ, ー and kana outside the course', () => {
    expect(requiredKana('きゃく', course)).toEqual(['きゃ', 'く']);
    expect(requiredKana('ココア', course)).toEqual(['コ', 'コ', 'ア']);
    expect(requiredKana('かっこ', course)).toEqual(['か', 'こ']);
    expect(requiredKana('コーク', course)).toEqual(['コ', 'ク']);
    expect(requiredKana('きょう', course)).toEqual(['き', 'う']);
  });
});

describe('grammarDueToday', () => {
  it('is due on the first day and every 2nd study day after', () => {
    expect(grammarDueToday([], [], '2026-10-14')).toBe(true);
    expect(grammarDueToday(['2026-10-14'], ['2026-10-14'], '2026-10-14')).toBe(false);
    expect(grammarDueToday(['2026-10-13'], ['2026-10-13'], '2026-10-14')).toBe(false);
    expect(grammarDueToday(['2026-10-12'], ['2026-10-12', '2026-10-13'], '2026-10-14')).toBe(true);
  });

  it('counts study days, not calendar days', () => {
    expect(grammarDueToday(['2026-10-01'], ['2026-10-01'], '2026-10-14')).toBe(false);
    expect(grammarDueToday(['2026-10-01'], ['2026-10-01', '2026-10-09'], '2026-10-14')).toBe(true);
  });
});

describe('phaseFor', () => {
  it('stays in phase 1 until every basic hiragana and katakana is introduced', () => {
    expect(phaseFor(snapshot())).toBe(1);
    expect(phaseFor(snapshot({ introduced: new Set(BASIC_KANA.slice(1)) }))).toBe(1);
    expect(phaseFor(snapshot({ introduced: new Set(BASIC_KANA) }))).toBe(2);
  });

  it('skips phase 1 when the learner knows both scripts', () => {
    expect(phaseFor(snapshot({ knowsHiragana: true }))).toBe(1);
    expect(phaseFor(snapshot({ knowsHiragana: true, knowsKatakana: true }))).toBe(2);
  });

  it('follows the phase of the first curriculum unit not yet introduced', () => {
    const introduced = (units: number) => new Set([...BASIC_KANA, ...UNITS.slice(0, units)]);
    expect(phaseFor(snapshot({ introduced: introduced(2) }))).toBe(2);
    expect(phaseFor(snapshot({ introduced: introduced(3) }))).toBe(3);
    expect(phaseFor(snapshot({ introduced: introduced(4) }))).toBe(4);
    expect(phaseFor(snapshot({ introduced: introduced(5) }))).toBe(4);
  });

  it('does not jump to phase 4 when the curriculum is empty', () => {
    const empty = { units: [], phaseEnds: {} };
    expect(phaseFor(snapshot({ curriculum: empty, knowsHiragana: true, knowsKatakana: true }))).toBe(2);
    // Phase-3 grammar stays locked.
    const plan = planNewItems(
      snapshot({
        curriculum: empty,
        knowsHiragana: true,
        knowsKatakana: true,
        grammarDue: true,
        survival: [],
        grammar: [...GRAMMAR, { ...GRAMMAR[0], id: 'g-3', order: 9, phase: 3 }],
        introduced: new Set(['grammar:g-wa', 'grammar:g-ka', 'grammar:g-te']),
      }),
      5,
    );
    expect(plan).toEqual([]);
  });
});

describe('planNewItems', () => {
  it('starts with the first kana row', () => {
    const plan = planNewItems(snapshot({ grammarDue: true }), 5);
    expect(keys(plan)).toEqual([...'あいうえお']);
    expect(plan[0]).toEqual({ itemId: 'kana:あ', kind: 'kana', key: 'あ' });
  });

  it('adds up to 2 survival words a day once all their kana are known', () => {
    const introduced = new Set(kanaIds('あいうえお'));
    expect(keys(planNewItems(snapshot({ introduced }), 5))).toEqual(['か', 'き', 'く', 'sw-ai', 'sw-iie']);
    expect(keys(planNewItems(snapshot({ introduced, vocabToday: 1 }), 5))).toEqual(['か', 'き', 'く', 'け', 'sw-ai']);
    expect(keys(planNewItems(snapshot({ introduced, vocabToday: 2 }), 5))).toEqual([...'かきくけこ']);
  });

  it('waits for yōon and dakuten before words that need them', () => {
    const introduced = new Set(kanaIds([...BASIC_HIRAGANA, 'き', 'く']));
    const words = (s: Set<string>) => planNewItems(snapshot({ introduced: s }), 8).filter((p) => p.kind === 'vocab');
    expect(keys(words(new Set([...introduced, 'vocab:sw-ai', 'vocab:sw-iie'])))).toEqual(['sw-kao']);
    const withYoon = new Set([...introduced, 'vocab:sw-ai', 'vocab:sw-iie', ...kanaIds(['きゃ'])]);
    expect(keys(words(withYoon))).toEqual(['sw-kyaku', 'sw-kao']);
  });

  it('adds a grammar point on grammar days once its kana can be read', () => {
    const introduced = new Set(kanaIds(BASIC_HIRAGANA));
    expect(keys(planNewItems(snapshot({ introduced, grammarDue: true }), 5))).toEqual(['が', 'ご', 'きゃ', 'sw-ai', 'g-wa']);
    expect(keys(planNewItems(snapshot({ introduced, grammarDue: false }), 5))).toEqual(['が', 'ご', 'きゃ', 'sw-ai', 'sw-iie']);

    const early = new Set(kanaIds('あいうえお'));
    expect(grammarIn(planNewItems(snapshot({ introduced: early, grammarDue: true }), 5))).toEqual([]);
  });

  it('needs every kana in the pattern, examples (furigana included), drills and options', () => {
    const plan = (kana: string[]) => planNewItems(snapshot({ introduced: new Set(kanaIds(kana)), grammarDue: true }), 5);
    expect(grammarIn(plan(G_WA_KANA))).toEqual(['g-wa']);
    for (const missing of G_WA_KANA) {
      expect(grammarIn(plan(G_WA_KANA.filter((k) => k !== missing))), `without ${missing}`).toEqual([]);
    }
  });

  it('reads a course yōon as one kana and skips ー and other small kana', () => {
    const needed = ['が', 'きゃ', 'く', 'き', 'う', 'ご', 'い'];
    const plan = (kana: string[]) =>
      planNewItems(snapshot({ introduced: new Set([...kanaIds(kana), 'grammar:g-wa']), grammarDue: true }), 5);
    expect(grammarIn(plan(needed))).toEqual(['g-ka']);
    expect(grammarIn(plan(needed.filter((k) => k !== 'きゃ')))).toEqual([]);
  });

  it('teaches grammar in order: a point that cannot be read yet holds back the ones after it', () => {
    // g-ka (order 2) is readable, but g-wa (order 1) still needs あ, こ, え, お.
    const introduced = new Set(kanaIds(['が', 'きゃ', 'く', 'き', 'う', 'ご', 'い', 'か']));
    expect(grammarIn(planNewItems(snapshot({ introduced, grammarDue: true }), 5))).toEqual([]);
  });

  it('counts whole scripts the learner already knows as readable', () => {
    expect(grammarIn(planNewItems(snapshot({ knowsHiragana: true, grammarDue: true }), 5))).toEqual(['g-wa']);
  });

  it('only offers grammar from the current phase or earlier', () => {
    const introduced = new Set([...kanaIds(BASIC_HIRAGANA), 'grammar:g-wa', 'grammar:g-ka']);
    expect(planNewItems(snapshot({ introduced, grammarDue: true }), 5).some((p) => p.kind === 'grammar')).toBe(false);

    const phase2 = new Set([...ALL_KANA, 'grammar:g-wa', 'grammar:g-ka']);
    expect(keys(planNewItems(snapshot({ introduced: phase2, grammarDue: true }), 5)).at(-1)).toBe('g-te');
  });

  it('teaches leftover phase-1 grammar after skipping the kana course', () => {
    const plan = planNewItems(snapshot({ knowsHiragana: true, knowsKatakana: true, grammarDue: true, survival: [] }), 4);
    expect(keys(plan)).toEqual(['亻', '一', '人', 'g-wa']);
  });

  it('keeps at least half the slots for the core track', () => {
    const introduced = new Set(kanaIds(BASIC_HIRAGANA));
    expect(keys(planNewItems(snapshot({ introduced, grammarDue: true }), 1))).toEqual(['が']);
    expect(keys(planNewItems(snapshot({ introduced, grammarDue: true }), 2))).toEqual(['が', 'g-wa']);
  });

  it('moves from kana to curriculum units, listing each kanji unit’s words', () => {
    const plan = planNewItems(snapshot({ introduced: new Set([...ALL_KANA, 'word:1003']), survival: [] }), 3);
    expect(plan).toEqual([
      { itemId: 'radical:亻', kind: 'radical', key: '亻' },
      { itemId: 'kanji:一', kind: 'kanji', key: '一', words: ['1001'] },
      { itemId: 'kanji:人', kind: 'kanji', key: '人', words: ['1002'] },
    ]);
  });

  it('skips kana of scripts the learner knows', () => {
    const plan = planNewItems(snapshot({ knowsHiragana: true }), 4);
    expect(keys(plan)).toEqual(['ア', 'イ', 'sw-ai', 'sw-iie']);
  });

  it('fills the day with words and grammar once the core track is done', () => {
    const introduced = new Set([...ALL_KANA, ...UNITS]);
    expect(keys(planNewItems(snapshot({ introduced, grammarDue: true }), 5))).toEqual(['sw-ai', 'sw-iie', 'g-wa']);
  });

  it('plans nothing for a count of 0', () => {
    expect(planNewItems(snapshot(), 0)).toEqual([]);
  });
});

describe('planNewItems: a second session the same day', () => {
  it('offers exactly what is left, keeping the day’s survival words', () => {
    const start = new Set(kanaIds('あいうえお'));
    expect(keys(planNewItems(snapshot({ introduced: start }), 5))).toEqual(['か', 'き', 'く', 'sw-ai', 'sw-iie']);

    const after = new Set([...start, ...kanaIds('かきく')]);
    expect(keys(planNewItems(snapshot({ introduced: after, newToday: 3 }), 2))).toEqual(['sw-ai', 'sw-iie']);
  });

  it('keeps the day’s grammar point', () => {
    const start = new Set(kanaIds(BASIC_HIRAGANA));
    const morning = planNewItems(snapshot({ introduced: start, grammarDue: true }), 5);
    expect(keys(morning)).toEqual(['が', 'ご', 'きゃ', 'sw-ai', 'g-wa']);

    const after = new Set([...start, ...kanaIds(['が', 'ご', 'きゃ'])]);
    expect(keys(planNewItems(snapshot({ introduced: after, grammarDue: true, newToday: 3 }), 2))).toEqual(['sw-ai', 'g-wa']);

    after.add('vocab:sw-ai');
    const last = snapshot({ introduced: after, grammarDue: true, newToday: 4, vocabToday: 1 });
    expect(keys(planNewItems(last, 1))).toEqual(['g-wa']);
  });

  it('keeps the core track’s share when words and grammar came first', () => {
    const introduced = new Set([...kanaIds(BASIC_HIRAGANA), 'vocab:sw-ai', 'grammar:g-wa']);
    const s = snapshot({ introduced, newToday: 2, vocabToday: 1, grammarToday: 1 });
    expect(keys(planNewItems(s, 3))).toEqual(['が', 'ご', 'きゃ']);
  });

  it('keeps the day’s limits, and its words and grammar, however the day is split', () => {
    const random = seededRandom(11);
    const isExtra = (p: NewItemPlan) => p.kind === 'vocab' || p.kind === 'grammar';
    for (let run = 0; run < 30; run++) {
      const perDay = 1 + Math.floor(random() * 6);
      const introduced = new Set<string>();
      let lastGrammarDay = -2;
      for (let day = 0; day < 15; day++) {
        const grammarDue = lastGrammarDay < day - 1;
        const oneSession = planNewItems(snapshot({ introduced: new Set(introduced), grammarDue }), perDay);
        const done = { newToday: 0, vocabToday: 0, grammarToday: 0 };
        let core = 0;
        // Sessions until the day's budget is used, each stopping after a random part of its plan.
        while (done.newToday < perDay) {
          const s = snapshot({ introduced, grammarDue: grammarDue && !done.grammarToday, ...done });
          const plan = planNewItems(s, perDay - done.newToday);
          if (!plan.length) break;
          for (const item of plan.slice(0, 1 + Math.floor(random() * plan.length))) {
            introduced.add(item.itemId);
            done.newToday++;
            if (item.kind === 'vocab') done.vocabToday++;
            else if (item.kind === 'grammar') done.grammarToday++;
            else core++;
          }
        }
        if (done.grammarToday) lastGrammarDay = day;

        const where = `run ${run}, ${perDay} a day, day ${day}`;
        expect(done.vocabToday, where).toBeLessThanOrEqual(SURVIVAL_WORDS_PER_DAY);
        expect(done.grammarToday, where).toBeLessThanOrEqual(1);
        expect(done.vocabToday + done.grammarToday, where).toBeGreaterThanOrEqual(oneSession.filter(isExtra).length);
        const coreLeft = planNewItems(snapshot({ introduced, survival: [], grammar: [] }), 1).length > 0;
        if (coreLeft) expect(core, where).toBeGreaterThanOrEqual(Math.ceil(perDay / 2));
      }
    }
  });
});

describe('upcomingUnits and nextUnits', () => {
  it('lists the next units not yet introduced, in teaching order', () => {
    const shuffled = { ...CURRICULUM, units: shuffle(CURRICULUM.units, seededRandom(3)) };
    expect(upcomingUnits(shuffled, new Set(['radical:亻', 'kanji:人']), 2).map((u) => u.char)).toEqual(['一', '大']);
    expect(upcomingUnits(CURRICULUM, new Set(), 0)).toEqual([]);
  });

  it('reads what has been introduced from the database', async () => {
    expect(await nextUnits(2)).toEqual(CURRICULUM.units.slice(0, 2));
    await markKnownMany([
      { kind: 'radical', key: '亻' },
      { kind: 'kanji', key: '人' },
    ]);
    expect((await nextUnits(10)).map((u) => u.char)).toEqual(['一', '大', '水']);
    expect(await nextUnits(0)).toEqual([]);
  });
});

describe('nextNewItems and introducePlanItem', () => {
  const DAY1 = at(2026, 10, 12, 8);
  const DAY2 = at(2026, 10, 13, 8);
  const DAY3 = at(2026, 10, 14, 8);

  it('introduces a kanji with its words; only the kanji counts as new', async () => {
    fixtures.grammar = [];
    fixtures.survival = [];
    await markKnownMany(KANA.map((k) => ({ kind: 'kana' as const, key: k.char })), DAY1);
    const [radical, kanji] = await nextNewItems(2, DAY1);
    expect(radical.key).toBe('亻');
    expect(kanji).toMatchObject({ key: '一', words: ['1001'] });

    const results = await introducePlanItem(kanji, DAY1);
    expect(results.map((r) => r.item.id)).toEqual(['kanji:一', 'word:1001']);
    expect(await db.items.get('word:1001')).toBeDefined();
    expect(await db.cards.where('itemId').equals('word:1001').count()).toBe(2);
    expect((await db.days.get('2026-10-12'))!.newItems).toBe(1);

    expect(keys(await nextNewItems(2, DAY1))).toEqual(['亻', '人']);
  });

  it('spaces grammar points to every 2nd study day', async () => {
    await markKnownMany(BASIC_HIRAGANA.map((key) => ({ kind: 'kana' as const, key })), DAY1);
    fixtures.survival = [];

    const day1 = await nextNewItems(5, DAY1);
    expect(day1.at(-1)!.kind).toBe('grammar');
    for (const item of day1) await introducePlanItem(item, DAY1);

    const day2 = await nextNewItems(5, DAY2);
    expect(day2.some((p) => p.kind === 'grammar')).toBe(false);
    for (const item of day2) await introducePlanItem(item, DAY2);

    const day3 = await nextNewItems(5, DAY3);
    expect(day3.at(-1)).toMatchObject({ kind: 'grammar', key: 'g-ka' });
  });

  it('tops the day up from where an earlier session stopped', async () => {
    await markKnownMany(BASIC_HIRAGANA.map((key) => ({ kind: 'kana' as const, key })), DAY1);
    const morning = await nextNewItems(5, DAY1);
    expect(keys(morning)).toEqual(['が', 'ご', 'きゃ', 'sw-ai', 'g-wa']);
    for (const item of morning.slice(0, 3)) await introducePlanItem(item, DAY1);

    const evening = at(2026, 10, 12, 20);
    expect(keys(await nextNewItems(2, evening))).toEqual(['sw-ai', 'g-wa']);
    await introducePlanItem(morning[4], evening);
    expect(keys(await nextNewItems(1, evening))).toEqual(['sw-ai']);
  });

  it('caps survival words at 2 per day across several sessions', async () => {
    fixtures.grammar = [];
    await markKnownMany(BASIC_HIRAGANA.map((key) => ({ kind: 'kana' as const, key })), DAY1);
    await introduceItem('vocab', 'sw-ai', DAY1);
    const later = await nextNewItems(5, at(2026, 10, 12, 20));
    expect(later.filter((p) => p.kind === 'vocab').map((p) => p.key)).toEqual(['sw-iie']);
    const tomorrow = await nextNewItems(5, DAY2);
    expect(tomorrow.filter((p) => p.kind === 'vocab')).toHaveLength(2);
  });
});

describe('phase transitions', () => {
  it('moves to phase 2 when both scripts are marked as known', async () => {
    expect(await currentPhase()).toBe(1);
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    expect(await currentPhase()).toBe(2);

    const now = at(2026, 10, 14, 9);
    expect(await applyKnownKana(now)).toBe(KANA.length);
    expect(await db.items.where('kind').equals('kana').count()).toBe(KANA.length);
    const cards = await db.cards.where('kind').equals('kana').toArray();
    expect(cards.every((c) => c.state === State.Review && c.due > now)).toBe(true);
    expect(await db.days.get('2026-10-14')).toBeUndefined();
    expect(keys(await nextNewItems(1, now))).toEqual(['亻']);
  });

  it('stays in phase 1 for katakana when only hiragana is known', async () => {
    await updateSettings({ knowsHiragana: true });
    await applyKnownKana();
    expect(await currentPhase()).toBe(1);
    expect(keys(await nextNewItems(2))[0]).toBe('ア');
  });

  it('reaches phase 2 by introducing every basic kana', async () => {
    for (const k of KANA.filter((e) => e.kind === 'basic')) await introduceItem('kana', k.char);
    expect(await currentPhase()).toBe(2);
  });
});

describe('courseProgress', () => {
  it('reports kana progress toward phase 2', async () => {
    await markKnownMany(BASIC_HIRAGANA.map((key) => ({ kind: 'kana' as const, key })));
    expect(await courseProgress()).toEqual({
      phase: 1,
      kanaIntroduced: BASIC_HIRAGANA.length,
      kanaTotal: KANA.length,
      unitsIntroduced: 0,
      unitsTotal: CURRICULUM.units.length,
      kanjiIntroduced: 0,
      nextPhaseAt: 22,
      phaseDone: BASIC_HIRAGANA.length,
    });
  });

  it('reports kanji progress toward the next phase', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await markKnownMany([
      { kind: 'radical', key: '亻' },
      { kind: 'kanji', key: '一' },
    ]);
    expect(await courseProgress()).toMatchObject({
      phase: 2,
      unitsIntroduced: 2,
      kanjiIntroduced: 1,
      nextPhaseAt: 2,
      phaseDone: 1,
    });
  });
});
