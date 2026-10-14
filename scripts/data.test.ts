// @vitest-environment node
// Sanity checks on the generated public/data files (skipped until
// `npm run build:data` has produced them).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  Curriculum,
  CurriculumUnit,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  StrokesFile,
  WordEntry,
} from '../src/lib/types.ts';

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const built = existsSync(`${DATA}curriculum.json`) && existsSync(`${DATA}strokes.json`);
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;

describe.skipIf(!built)('generated data', () => {
  let kana: KanaEntry[];
  let kanji: Record<string, KanjiEntry>;
  let radicals: RadicalEntry[];
  let words: WordEntry[];
  let strokes: StrokesFile;
  let units: CurriculumUnit[];
  let phaseEnds: Record<string, number>;
  let unitIndex: Map<string, number>;
  let kanjiUnits: CurriculumUnit[];

  beforeAll(() => {
    kana = read<KanaEntry[]>('kana.json');
    kanji = read<Record<string, KanjiEntry>>('kanji.json');
    radicals = read<RadicalEntry[]>('radicals.json');
    words = read<WordEntry[]>('words.json');
    strokes = read<StrokesFile>('strokes.json');
    ({ units, phaseEnds } = read<Curriculum>('curriculum.json'));
    unitIndex = new Map(units.map((u) => [u.char, u.index]));
    kanjiUnits = units.filter((u) => u.type === 'kanji');
  });

  it('has stroke data with the right counts', () => {
    expect(strokes['水']).toHaveLength(4);
    expect(strokes['あ']).toHaveLength(3);
    expect(strokes['ア']).toHaveLength(2);
    expect(strokes['語']).toHaveLength(14);
    expect(strokes['水'][0]).toMatch(/^M[\d.]+,[\d.]+/);
  });

  it('has strokes for every kana and every curriculum unit', () => {
    for (const k of kana) if ([...k.char].length === 1) expect(strokes[k.char], k.char).toBeDefined();
    for (const u of units) expect(strokes[u.char]?.length, u.char).toBeGreaterThan(0);
  });

  it('teaches all 2,136 jōyō kanji once, with matching kanji entries', () => {
    expect(kanjiUnits).toHaveLength(2136);
    expect(new Set(units.map((u) => u.char)).size).toBe(units.length);
    expect(Object.keys(kanji)).toEqual(kanjiUnits.map((u) => u.char));
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
    expect(kanji['水']).toMatchObject({ char: '水', on: ['スイ'], kun: ['みず'], strokeCount: 4, grade: 1, jlptOld: 4 });
    expect(kanji['水'].meanings[0]).toBe('water');
  });

  it('keeps on readings in katakana and kun readings in hiragana', () => {
    for (const k of Object.values(kanji)) {
      for (const r of k.on) expect(r, `${k.char} on`).toMatch(/^[ァ-ヺー]+$/);
      for (const r of k.kun) expect(r, `${k.char} kun`).toMatch(/^[ぁ-ゖー.]+$/);
    }
    expect(kanji['志'].kun).not.toContain('シリング');
  });

  it('starts with the most common kanji', () => {
    expect(kanjiUnits.slice(0, 20).map((u) => u.char)).toContain('日');
    expect(unitIndex.get('一')!).toBeLessThan(20);
    expect(unitIndex.get('人')!).toBeLessThan(unitIndex.get('鬱')!);
  });

  it('teaches components before the kanji that use them', () => {
    for (const u of kanjiUnits) {
      for (const c of kanji[u.char].components) expect(unitIndex.get(c)!, `${c} in ${u.char}`).toBeLessThan(u.index);
    }
    expect(kanji['語'].components).toEqual(['言', '五', '口']);
    expect(kanji['海'].components).toContain('氵');
  });

  it('only ships radicals that a unit uses, each taught once as a radical unit', () => {
    const radicalUnits = units.filter((u) => u.type === 'radical');
    expect(radicals.map((r) => r.char).sort()).toEqual(radicalUnits.map((u) => u.char).sort());
    expect(radicals.find((r) => r.char === '氵')).toMatchObject({ name: 'water (side)', variantOf: '水' });
    expect(radicals.find((r) => r.char === '隹')?.meaning).toBe('bird');
    for (const u of radicalUnits) expect(u.words).toEqual([]);
    const usedAsComponent = new Set(kanjiUnits.flatMap((u) => kanji[u.char].components));
    for (const r of radicals) expect(usedAsComponent.has(r.char), r.char).toBe(true);
  });

  it('has sensible phase boundaries', () => {
    const kanjiBefore = (end: number) => units.slice(0, end).filter((u) => u.type === 'kanji').length;
    expect(kanjiBefore(phaseEnds['2'])).toBe(300);
    expect(units[phaseEnds['2'] - 1].type).toBe('kanji');
    expect(kanjiBefore(phaseEnds['3'])).toBe(800);
    expect(phaseEnds['4']).toBe(units.length);
    for (const u of units) {
      const expected = u.index < phaseEnds['2'] ? 2 : u.index < phaseEnds['3'] ? 3 : 4;
      expect(u.phase).toBe(expected);
    }
  });

  it('has unique, well-formed words', () => {
    const ids = words.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(words.length).toBeGreaterThan(10000);
    for (const w of words) {
      expect(w.meanings.length).toBeGreaterThan(0);
      expect(w.meanings.length).toBeLessThanOrEqual(3);
      expect(w.kanji.length).toBeGreaterThan(0);
      for (const ch of w.kanji) expect(kanji[ch], `${ch} in ${w.written}`).toBeDefined();
      expect(w.freqRank >= 1 && w.freqRank <= 49).toBe(true);
    }
    expect(words.find((w) => w.written === '水' && w.kana === 'みず')?.meanings[0]).toBe('water');
  });

  it('keeps negations in meanings', () => {
    const meaningsOf = (written: string) => words.find((w) => w.written === written)?.meanings;
    expect(meaningsOf('全然')?.[0]).toBe('not at all');
    expect(meaningsOf('決して')?.[0]).toBe('not ever');
    expect(meaningsOf('必ずしも')?.[0]).toBe('not always');
  });

  it('gives each unit at most three taught words, each word to one unit', () => {
    const byId = new Map(words.map((w) => [w.id, w]));
    const used = units.flatMap((u) => u.words);
    expect(new Set(used).size).toBe(used.length);
    for (const u of kanjiUnits) {
      expect(u.words.length).toBeLessThanOrEqual(3);
      for (const id of u.words) {
        const w = byId.get(id)!;
        expect(w.kanji).toContain(u.char);
        for (const ch of w.kanji) expect(unitIndex.get(ch)!).toBeLessThanOrEqual(u.index);
      }
    }
    const firstWord = (ch: string) => byId.get(units[unitIndex.get(ch)!].words[0])?.written;
    expect(firstWord('水')).toBe('水');
    expect(firstWord('見')).toBe('見る');
    expect(firstWord('人')).toBe('人');
    expect(firstWord('食')).toBe('食べる');
    expect(firstWord('多')).toBe('多い');
    expect(firstWord('長')).toBe('長い');
    expect(firstWord('休')).toBe('休む');
    expect(firstWord('不')).toBe('不安');
  });

  it('never opens a unit with a bare prefix or suffix', () => {
    const byId = new Map(words.map((w) => [w.id, w]));
    const bound = new Set(['pref', 'suf', 'n-pref', 'n-suf']);
    for (const u of kanjiUnits) {
      const first = byId.get(u.words[0] ?? '');
      if (!first || u.words.length === 1) continue;
      expect(first.pos.every((p) => bound.has(p)) || /^-|-$/.test(first.meanings[0]), `${u.char} ${first.written}`).toBe(false);
    }
  });

  it('lists kana in teaching order', () => {
    expect(kana).toHaveLength(208);
    expect(kana.slice(0, 5).map((k) => k.char).join('')).toBe('あいうえお');
    expect(kana.map((k) => k.order)).toEqual(kana.map((_, i) => i));
  });
});
