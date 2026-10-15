import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoreWord, Curriculum, GrammarPoint, KanaEntry, KanaRule, KanjiEntry, WordEntry } from '../lib/types.ts';
import { componentMap } from './course.ts';
import { weekStart } from './days.ts';
import { simulate, syntheticCourse, type SimCourse, type SimDay } from './simulate.ts';
import { REAL_KANA, REAL_RULES } from './test-fixtures.ts';

const course = syntheticCourse(REAL_KANA, REAL_RULES);
const minutes = (d: SimDay) => d.totalSec / 60;
const byDay = (days: readonly SimDay[], n: number) => days.find((d) => d.day === n)!;
const meanMinutes = (days: readonly SimDay[], from: number, to: number) => {
  const span = days.filter((d) => d.day >= from && d.day <= to);
  return span.reduce((s, d) => s + minutes(d), 0) / span.length;
};

describe('syntheticCourse', () => {
  it('has the shape of the real course', () => {
    expect(course.curriculum.units).toHaveLength(2136);
    expect(course.curriculum.units.filter((u) => u.anchor === null)).toHaveLength(51);
    const words = course.curriculum.units.reduce((s, u) => s + (u.anchor ? 1 : 0) + u.staged.length, 0);
    expect(words / (2136 - 51)).toBeCloseTo(2.68, 2);
    expect(course.core).toHaveLength(1577);
    expect(course.core.filter((w) => w.use)).toHaveLength(409);
    expect(Math.max(...course.core.filter((w) => w.use).map((w) => w.order))).toBe(415);
    expect(course.grammar).toHaveLength(115);
    expect(course.grammar.filter((g) => g.recognitionOnly)).toHaveLength(4);
    expect(course.grammar.every((g, i) => (i === 0 ? g.prerequisites.length === 0 : g.prerequisites[0] === course.grammar[i - 1].id))).toBe(true);
  });
});

describe.each([1, 2])('365 days at 25 min, seed %i', (seed) => {
  let days: SimDay[] = [];
  let elapsed = 0;
  beforeAll(() => {
    const started = performance.now();
    days = simulate({ course, budgetMin: 25, days: 365, seed }).days;
    elapsed = performance.now() - started;
  }, 20_000);

  it('runs in under 5 s', () => {
    expect(days).toHaveLength(365);
    expect(elapsed).toBeLessThan(5000);
  });

  it('plans about 11 minutes on day 1 and about 25 afterwards, never above 27.5', () => {
    expect(minutes(byDay(days, 1))).toBeGreaterThanOrEqual(9.9);
    expect(minutes(byDay(days, 1))).toBeLessThanOrEqual(12.1);
    for (const [from, to] of [[15, 17], [60, 62], [180, 182]]) {
      const mean = meanMinutes(days, from, to);
      expect(mean, `days ${from}–${to}`).toBeGreaterThanOrEqual(22.5);
      expect(mean, `days ${from}–${to}`).toBeLessThanOrEqual(27.5);
    }
    const later = meanMinutes(days, 31, 365);
    expect(later).toBeGreaterThanOrEqual(23);
    expect(later).toBeLessThanOrEqual(27);
    for (const d of days) expect(minutes(d), `day ${d.day}`).toBeLessThanOrEqual(27.5);
  });

  it('runs the kana sprint on days 1–14', () => {
    expect(byDay(days, 5).kana).toBe(46);
    expect(byDay(days, 12).kana).toBe(92);
    const ruleDays = days.filter((d) => d.rulesToday.length).map((d) => [d.day, d.rulesToday.join()]);
    expect(ruleDays).toEqual([[6, 'hira-dakuten'], [7, 'hira-yoon'], [13, 'kata-dakuten-yoon'], [14, 'kata-extended']]);
    expect(days.filter((d) => d.mode === 'sprint').map((d) => d.day)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(days.filter((d) => d.day < 15).every((d) => d.kanji === 0)).toBe(true);
    expect(byDay(days, 15).newKanjiToday).toBeGreaterThanOrEqual(1);
  });

  it('teaches 3 core words a day from day 3', () => {
    for (let n = 3; n <= 14; n++) expect(byDay(days, n).coreToday, `day ${n}`).toBe(3);
    expect(days.filter((d) => d.day <= 14).reduce((s, d) => s + d.coreToday, 0)).toBe(36);
    expect(days.filter((d) => d.day < 3).every((d) => d.coreToday === 0)).toBe(true);
  });

  it('teaches grammar from day 8, never on consecutive study days, at least 2 a week', () => {
    expect(days.find((d) => d.newGrammarToday > 0)?.day).toBe(8);
    for (let i = 1; i < days.length; i++) {
      expect(days[i - 1].newGrammarToday > 0 && days[i].newGrammarToday > 0, `days ${days[i - 1].day}–${days[i].day}`).toBe(false);
    }
    const weeks = new Map<string, SimDay[]>();
    for (const d of days) weeks.set(weekStart(d.date), [...(weeks.get(weekStart(d.date)) ?? []), d]);
    for (const [week, span] of weeks) {
      const complete = span.length === 7 && span[0].day >= 8 && span[6].day <= 180;
      if (!complete || span.some((d) => d.mode === 'catch-up')) continue;
      expect(span.reduce((s, d) => s + d.newGrammarToday, 0), `week of ${week}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('never introduces more than 3 numbers a day', () => {
    expect(Math.max(...days.map((d) => d.numbersToday))).toBeLessThanOrEqual(3);
  });

  it('reaches ≥ 240 kanji and ≥ 1,300 words by day 365', () => {
    expect(byDay(days, 365).kanji).toBeGreaterThanOrEqual(240);
    expect(byDay(days, 365).words).toBeGreaterThanOrEqual(1300);
  });
});

describe('missed days and review-only days', () => {
  it('never loses a kana row when days are missed', { timeout: 20_000 }, () => {
    const { days } = simulate({ course, budgetMin: 25, days: 30, seed: 3, missDayEvery: 3 });
    expect(days.map((d) => d.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(byDay(days, 12).kana).toBe(92);
    expect(byDay(days, 15).newKanjiToday).toBeGreaterThanOrEqual(1);
  });

  it('teaches a row skipped by a review-only day on the next days, and starts kanji after the last sprint item', { timeout: 20_000 }, () => {
    const { days } = simulate({ course, budgetMin: 25, days: 30, seed: 3, skipTeachDays: [3] });
    expect(byDay(days, 3).kanaToday).toBe(0);
    expect(byDay(days, 4).kana).toBe(30);
    const total = days.reduce((s, d) => s + d.kanaToday, 0);
    expect(total).toBe(92);
    expect(days.flatMap((d) => d.rulesToday)).toEqual(['hira-dakuten', 'hira-yoon', 'kata-dakuten-yoon', 'kata-extended']);
    const lastSprint = Math.max(...days.filter((d) => d.kanaToday > 0 || d.rulesToday.length).map((d) => d.day));
    const firstKanji = days.find((d) => d.newKanjiToday > 0)!.day;
    expect(lastSprint).toBeGreaterThanOrEqual(14);
    expect(firstKanji).toBe(Math.max(15, lastSprint + 1));
    expect(days.filter((d) => d.day < firstKanji).every((d) => d.kanji === 0)).toBe(true);
  });
});

describe('keepState', () => {
  it('returns a consistent state with real course ids', { timeout: 20_000 }, () => {
    const { state } = simulate({ course, budgetMin: 25, days: 40, seed: 1, keepState: true });
    expect(state).toBeDefined();
    const items = new Set(state!.items.map((i) => i.id));
    const cards = new Set(state!.cards.map((c) => c.id));
    expect(state!.cards.every((c) => items.has(c.itemId))).toBe(true);
    expect(state!.logs.every((l) => cards.has(l.cardId))).toBe(true);
    const kanji = new Set(course.curriculum.units.map((u) => u.char));
    const core = new Set(course.core.map((w) => w.id));
    const grammar = new Set(course.grammar.map((g) => g.id));
    for (const item of state!.items) {
      if (item.kind === 'kanji') expect(kanji.has(item.key)).toBe(true);
      if (item.kind === 'core') expect(core.has(item.key)).toBe(true);
      if (item.kind === 'grammar') expect(grammar.has(item.key)).toBe(true);
    }
    expect(state!.items.some((i) => i.kind === 'kanji')).toBe(true);
    expect(state!.days).toHaveLength(40);
  });
});

/** The built course (npm run build:data), when present: the bands above must hold on the real data too. */
const DATA = join(process.cwd(), 'public', 'data');
const built = existsSync(join(DATA, 'curriculum.json')) && existsSync(join(DATA, 'content', 'core-words.json'));

describe.runIf(built)('365 days at 25 min on the real course', () => {
  let days: SimDay[] = [];
  beforeAll(() => {
    const read = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA, file), 'utf8')) as T;
    const words = new Map(read<WordEntry[]>('words.json').map((w) => [w.id, w]));
    const real: SimCourse = {
      kana: read<KanaEntry[]>('kana.json'),
      rules: read<KanaRule[]>('content/kana-rules.json'),
      curriculum: read<Curriculum>('curriculum.json'),
      core: read<CoreWord[]>('content/core-words.json').sort((a, b) => a.order - b.order),
      grammar: read<GrammarPoint[]>('content/grammar.json').sort((a, b) => a.order - b.order),
      wordUse: (ref) => words.get(ref.slice(5))?.use ?? false,
      wordKanji: (ref) => words.get(ref.slice(5))?.kanji ?? [],
      components: componentMap(read<Record<string, KanjiEntry>>('kanji.json')),
    };
    days = simulate({ course: real, budgetMin: 25, days: 365, seed: 1 }).days;
  }, 30_000);

  it('keeps about 25 minutes a day, starts kanji on day 15 and reaches ≥ 240 kanji and ≥ 1,300 words', () => {
    expect(minutes(byDay(days, 1))).toBeGreaterThanOrEqual(9.9);
    expect(minutes(byDay(days, 1))).toBeLessThanOrEqual(12.1);
    const later = meanMinutes(days, 31, 365);
    expect(later).toBeGreaterThanOrEqual(23);
    expect(later).toBeLessThanOrEqual(27);
    for (const d of days) expect(minutes(d), `day ${d.day}`).toBeLessThanOrEqual(27.5);
    expect(days.find((d) => d.newKanjiToday > 0)?.day).toBe(15);
    expect(byDay(days, 365).kanji).toBeGreaterThanOrEqual(240);
    expect(byDay(days, 365).words).toBeGreaterThanOrEqual(1300);
    expect(Math.max(...days.map((d) => d.numbersToday))).toBeLessThanOrEqual(3);
  });
});
