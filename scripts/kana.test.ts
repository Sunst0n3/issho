// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildKanaTable, isStrokeKana, toKatakana } from './lib/kana.ts';

const table = buildKanaTable();
const hiragana = table.filter((k) => k.script === 'hiragana');
const katakana = table.filter((k) => k.script === 'katakana');
const byChar = new Map(table.map((k) => [k.char, k]));

describe('kana table', () => {
  it('has 46 basic, 25 voiced and 33 yōon kana per script', () => {
    for (const script of [hiragana, katakana]) {
      expect(script).toHaveLength(104);
      expect(script.filter((k) => k.kind === 'basic')).toHaveLength(46);
      expect(script.filter((k) => k.kind === 'dakuten')).toHaveLength(20);
      expect(script.filter((k) => k.kind === 'handakuten')).toHaveLength(5);
      expect(script.filter((k) => k.kind === 'yoon')).toHaveLength(33);
    }
  });

  it('is in teaching order: hiragana rows, voiced rows, yōon, then katakana the same way', () => {
    expect(table.map((k) => k.order)).toEqual(table.map((_, i) => i));
    const groups = [...new Set(hiragana.map((k) => k.group))];
    expect(groups).toEqual([
      'a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa', 'n',
      'ga', 'za', 'da', 'ba', 'pa',
      'kya', 'sha', 'cha', 'nya', 'hya', 'mya', 'rya', 'gya', 'ja', 'bya', 'pya',
    ]);
    expect(table[0].char).toBe('あ');
    expect(table[45].char).toBe('ん');
    expect(table[104].char).toBe('ア');
    expect(katakana.map((k) => k.romaji)).toEqual(hiragana.map((k) => k.romaji));
  });

  it('uses Hepburn romaji and accepts the common alternatives', () => {
    expect(byChar.get('し')).toMatchObject({ romaji: 'shi', altRomaji: ['si'] });
    expect(byChar.get('ち')).toMatchObject({ romaji: 'chi', altRomaji: ['ti'] });
    expect(byChar.get('つ')).toMatchObject({ romaji: 'tsu', altRomaji: ['tu'] });
    expect(byChar.get('ふ')).toMatchObject({ romaji: 'fu', altRomaji: ['hu'] });
    expect(byChar.get('じ')).toMatchObject({ romaji: 'ji', altRomaji: ['zi'] });
    expect(byChar.get('ぢ')).toMatchObject({ romaji: 'ji', altRomaji: ['di'] });
    expect(byChar.get('づ')).toMatchObject({ romaji: 'zu', altRomaji: ['du'] });
    expect(byChar.get('を')).toMatchObject({ romaji: 'wo', altRomaji: ['o'] });
    expect(byChar.get('ん')).toMatchObject({ romaji: 'n', group: 'n' });
    expect(byChar.get('あ')?.altRomaji).toBeUndefined();
  });

  it('builds yōon from the i-row plus small ya/yu/yo', () => {
    expect(byChar.get('きゃ')).toMatchObject({ romaji: 'kya', group: 'kya', kind: 'yoon' });
    expect(byChar.get('しょ')).toMatchObject({ romaji: 'sho', altRomaji: ['syo'] });
    expect(byChar.get('ちゅ')).toMatchObject({ romaji: 'chu', altRomaji: ['tyu', 'cyu'] });
    expect(byChar.get('じゃ')).toMatchObject({ romaji: 'ja', altRomaji: ['zya', 'jya'] });
    expect(byChar.get('ピョ')).toMatchObject({ romaji: 'pyo', script: 'katakana' });
  });

  it('gives the 92 basic kana their sprint day: hiragana rows on days 1–5, katakana on 8–12', () => {
    const basic = table.filter((k) => k.kind === 'basic');
    expect(basic).toHaveLength(92);
    expect(table.filter((k) => k.sprintDay !== undefined)).toEqual(basic);
    const day = (ch: string) => byChar.get(ch)?.sprintDay;
    expect([day('あ'), day('こ'), day('さ'), day('と'), day('な'), day('ほ'), day('ま'), day('よ'), day('ら'), day('を'), day('ん')]).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5,
    ]);
    expect([day('ア'), day('ソ'), day('ン')]).toEqual([8, 9, 12]);
    for (const d of [1, 2, 3, 4, 5]) expect(hiragana.filter((k) => k.sprintDay === d).length, `day ${d}`).toBeGreaterThanOrEqual(8);
    expect(day('が')).toBeUndefined();
    expect(day('きゃ')).toBeUndefined();
  });

  it('has unique characters', () => {
    expect(byChar.size).toBe(table.length);
  });
});

describe('kana helpers', () => {
  it('converts hiragana to katakana, leaving other characters alone', () => {
    expect(toKatakana('きゃっと')).toBe('キャット');
    expect(toKatakana('ーa')).toBe('ーa');
  });

  it('selects kana that need stroke data', () => {
    expect(['あ', 'ゃ', 'ゔ', 'ア', 'ヶ', 'ー'].every(isStrokeKana)).toBe(true);
    expect(['・', '゛', 'ゝ', '水', 'a'].some(isStrokeKana)).toBe(false);
  });
});
