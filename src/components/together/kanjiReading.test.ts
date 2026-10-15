import { describe, expect, it } from 'vitest';
import type { KanjiEntry, WordEntry } from '../../lib/types.ts';
import { readingFor } from './kanjiReading.ts';

const entry = (char: string, meanings: string[], on: string[], kun: string[]): KanjiEntry => ({
  char, meanings, on, kun, strokeCount: 4, components: [], parts: [],
});
const word = (written: string, kana: string, meanings: string[], freqRank = 49): WordEntry => ({
  id: `${written}-${kana}`, written, kana, meanings, pos: ['n'], freqRank, kanji: [written],
});

describe('readingFor', () => {
  it('takes the reading of the word that means what the prompt says', () => {
    const tsuki = entry('月', ['month', 'moon'], ['ゲツ', 'ガツ'], ['つき']);
    expect(readingFor(tsuki, [word('月', 'つき', ['Moon']), word('月', 'がつ', ['month'])])).toBe('がつ');
    const hon = entry('本', ['book', 'origin'], ['ホン'], ['もと']);
    expect(readingFor(hon, [word('本', 'ほん', ['book', 'volume'], 3), word('本', 'もと', ['origin (book)'])])).toBe('ほん');
  });

  it('prefers the more common word, and ignores notes in brackets', () => {
    const hi = entry('日', ['day'], ['ニチ'], ['ひ']);
    expect(readingFor(hi, [word('日', 'にち', ['day (of the month)'], 40), word('日', 'ひ', ['day'], 3)])).toBe('ひ');
  });

  it('falls back to the on reading, then the kun reading without its okurigana mark', () => {
    expect(readingFor(entry('本', ['book'], ['ホン'], ['もと']), [])).toBe('ホン');
    expect(readingFor(entry('畑', ['field'], [], ['はたけ']), [])).toBe('はたけ');
    expect(readingFor(entry('込', ['crowded'], [], ['こ.む']), [])).toBe('こむ');
  });
});
