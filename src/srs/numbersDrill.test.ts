import { describe, expect, it } from 'vitest';
import { numbersDrill, readCounter, readNumber, readPrice, readTime } from './numbersDrill.ts';
import { seededRandom } from './random.ts';

describe('readNumber', () => {
  it.each([
    [0, 'ぜろ'],
    [10, 'じゅう'],
    [14, 'じゅうよん'],
    [300, 'さんびゃく'],
    [600, 'ろっぴゃく'],
    [800, 'はっぴゃく'],
    [1000, 'せん'],
    [3000, 'さんぜん'],
    [8000, 'はっせん'],
    [10_000, 'いちまん'],
    [1_000_000, 'ひゃくまん'],
    [10_000_000, 'いっせんまん'],
    [12_345, 'いちまんにせんさんびゃくよんじゅうご'],
    [99_999_999, 'きゅうせんきゅうひゃくきゅうじゅうきゅうまんきゅうせんきゅうひゃくきゅうじゅうきゅう'],
  ])('%i → %s', (n, kana) => {
    expect(readNumber(n)).toBe(kana);
  });

  it('refuses numbers out of range', () => {
    expect(() => readNumber(100_000_000)).toThrow(RangeError);
    expect(() => readNumber(-1)).toThrow(RangeError);
    expect(() => readNumber(1.5)).toThrow(RangeError);
  });
});

describe('readPrice', () => {
  it('reads yen, with 4 yen as よえん', () => {
    expect(readPrice(1500)).toBe('せんごひゃくえん');
    expect(readPrice(4)).toBe('よえん');
    expect(readPrice(104)).toBe('ひゃくよえん');
    expect(readPrice(300)).toBe('さんびゃくえん');
  });
});

describe('readTime', () => {
  it('reads hours with their irregular forms', () => {
    expect(readTime(4, 0)).toEqual(['よじ']);
    expect(readTime(7, 0)).toEqual(['しちじ']);
    expect(readTime(9, 0)).toEqual(['くじ']);
    expect(readTime(14, 0)).toEqual(['じゅうよじ']);
  });

  it('reads minutes with their sound changes and accepts the variants', () => {
    expect(readTime(7, 10)).toContain('しちじじゅっぷん');
    expect(readTime(7, 10)).toContain('しちじじっぷん');
    expect(readTime(1, 1)).toEqual(['いちじいっぷん']);
    expect(readTime(2, 3)).toEqual(['にじさんぷん']);
    expect(readTime(3, 8)).toEqual(['さんじはっぷん', 'さんじはちふん']);
    expect(readTime(5, 15)).toEqual(['ごじじゅうごふん']);
    expect(readTime(6, 30)).toEqual(['ろくじさんじゅっぷん', 'ろくじさんじっぷん', 'ろくじはん']);
  });
});

describe('readCounter', () => {
  it('reads native and Sino-Japanese counters with their sound changes', () => {
    expect(readCounter(1, '人')).toEqual(['ひとり']);
    expect(readCounter(2, '人')).toEqual(['ふたり']);
    expect(readCounter(4, '人')).toEqual(['よにん']);
    expect(readCounter(3, '本')).toEqual(['さんぼん']);
    expect(readCounter(1, '杯')).toEqual(['いっぱい']);
    expect(readCounter(6, '匹')).toEqual(['ろっぴき']);
    expect(readCounter(3, 'つ')).toEqual(['みっつ']);
    expect(readCounter(10, 'つ')).toEqual(['とお']);
    expect(readCounter(5, '枚')).toEqual(['ごまい']);
    expect(readCounter(8, '個')).toEqual(['はっこ', 'はちこ']);
    expect(readCounter(3, '回')).toEqual(['さんかい', 'さんがい']);
    expect(readCounter(20, '本')).toEqual(['にじゅっぽん', 'にじっぽん']);
    expect(readCounter(13, '本')).toEqual(['じゅうさんぼん']);
  });
});

describe('numbersDrill', () => {
  it('drills only the allowed kinds and is reproducible', () => {
    const onlyTsu = numbersDrill(seededRandom(1), { counters: ['つ'], time: false, prices: false, count: 12 });
    expect(new Set(onlyTsu.map((i) => i.kind))).toEqual(new Set(['number', 'counter']));
    expect(onlyTsu.filter((i) => i.kind === 'counter').every((i) => i.prompt.endsWith('つ'))).toBe(true);
    const all = numbersDrill(seededRandom(2), { counters: ['本', '人'], time: true, prices: true });
    expect(all).toHaveLength(10);
    expect(new Set(all.map((i) => i.kind))).toEqual(new Set(['number', 'price', 'time', 'counter']));
    expect(numbersDrill(seededRandom(2), { counters: ['本', '人'], time: true, prices: true })).toEqual(all);
    for (const item of all) expect(item.answers.length).toBeGreaterThan(0);
  });
});
