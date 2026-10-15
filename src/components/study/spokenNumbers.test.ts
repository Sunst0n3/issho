import { describe, expect, it } from 'vitest';
import { readCounter, readNumber, readPrice, readTime, type NumberDrillItem } from '../../srs/numbersDrill.ts';
import { spokenNumberMatches, writtenNumber } from './spokenNumbers.ts';

const number = (n: number): NumberDrillItem => ({ kind: 'number', prompt: n.toLocaleString('en-US'), answers: [readNumber(n)] });
const price = (yen: number): NumberDrillItem => ({ kind: 'price', prompt: `¥${yen.toLocaleString('en-US')}`, answers: [readPrice(yen)] });
const time = (h: number, m: number): NumberDrillItem => ({ kind: 'time', prompt: `${h}:${String(m).padStart(2, '0')}`, answers: readTime(h, m) });
const counter = (n: number, c: '本' | '人' | 'つ'): NumberDrillItem => ({ kind: 'counter', prompt: `${n}${c}`, answers: readCounter(n, c) });

describe('writtenNumber', () => {
  it('reads digits, kanji numerals and a mix of both', () => {
    expect(writtenNumber('1500')).toBe(1500);
    expect(writtenNumber('1,500')).toBe(1500);
    expect(writtenNumber('１５００')).toBe(1500);
    expect(writtenNumber('千五百')).toBe(1500);
    expect(writtenNumber('三百')).toBe(300);
    expect(writtenNumber('二十一')).toBe(21);
    expect(writtenNumber('十')).toBe(10);
    expect(writtenNumber('100万')).toBe(1_000_000);
    expect(writtenNumber('百万')).toBe(1_000_000);
    expect(writtenNumber('1万5000')).toBe(15_000);
    expect(writtenNumber('三万')).toBe(30_000);
  });

  it('is null for anything that is not a number', () => {
    expect(writtenNumber('')).toBeNull();
    expect(writtenNumber('さんびゃく')).toBeNull();
    expect(writtenNumber('3本')).toBeNull();
  });
});

describe('spokenNumberMatches', () => {
  it('accepts the reading in kana (either script), and only exactly', () => {
    expect(spokenNumberMatches('さんびゃく', number(300))).toBe(true);
    expect(spokenNumberMatches('サンビャク', number(300))).toBe(true);
    expect(spokenNumberMatches('ろくせんごひゃく', number(6400))).toBe(false);
    expect(spokenNumberMatches('', number(300))).toBe(false);
  });

  it('accepts a number the recognizer wrote in digits or kanji', () => {
    expect(spokenNumberMatches('300', number(300))).toBe(true);
    expect(spokenNumberMatches('三百。', number(300))).toBe(true);
    expect(spokenNumberMatches('1万5000', number(15_000))).toBe(true);
    expect(spokenNumberMatches('301', number(300))).toBe(false);
  });

  it('needs the yen for a price', () => {
    expect(spokenNumberMatches('1500円', price(1500))).toBe(true);
    expect(spokenNumberMatches('¥1,500', price(1500))).toBe(true);
    expect(spokenNumberMatches('せんごひゃくえん', price(1500))).toBe(true);
    expect(spokenNumberMatches('1500', price(1500))).toBe(false);
    expect(spokenNumberMatches('1600円', price(1500))).toBe(false);
  });

  it('reads hours and minutes, half past included', () => {
    expect(spokenNumberMatches('4時', time(4, 0))).toBe(true);
    expect(spokenNumberMatches('4:00', time(4, 0))).toBe(true);
    expect(spokenNumberMatches('よじ', time(4, 0))).toBe(true);
    expect(spokenNumberMatches('7時10分', time(7, 10))).toBe(true);
    expect(spokenNumberMatches('12時半', time(12, 30))).toBe(true);
    expect(spokenNumberMatches('7時', time(7, 10))).toBe(false);
    expect(spokenNumberMatches('8時10分', time(7, 10))).toBe(false);
  });

  it('needs the right counter as well as the right number', () => {
    expect(spokenNumberMatches('3本', counter(3, '本'))).toBe(true);
    expect(spokenNumberMatches('三本', counter(3, '本'))).toBe(true);
    expect(spokenNumberMatches('さんぼん', counter(3, '本'))).toBe(true);
    expect(spokenNumberMatches('ふたり', counter(2, '人'))).toBe(true);
    expect(spokenNumberMatches('3枚', counter(3, '本'))).toBe(false);
    expect(spokenNumberMatches('4本', counter(3, '本'))).toBe(false);
  });
});
