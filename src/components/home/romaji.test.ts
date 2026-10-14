import { describe, expect, it } from 'vitest';
import { kanaToRomaji } from './romaji.ts';

describe('kanaToRomaji', () => {
  it.each([
    ['みず', 'mizu'],
    ['スイ', 'sui'],
    ['しゃしん', 'shashin'],
    ['きょう', 'kyou'],
    ['じゅう', 'juu'],
    ['がっこう', 'gakkou'],
    ['まっちゃ', 'matcha'],
    ['コーヒー', 'koohii'],
    ['ちょっと', 'chotto'],
    ['ふつか', 'futsuka'],
  ])('%s → %s', (kana, romaji) => {
    expect(kanaToRomaji(kana)).toBe(romaji);
  });

  it('keeps a trailing small tsu, so ジッ and ジ differ', () => {
    expect(kanaToRomaji('ジッ')).toBe('jit');
    expect(kanaToRomaji('ジュッ')).toBe('jut');
    expect(kanaToRomaji('ジ')).toBe('ji');
    expect(kanaToRomaji('いっ.')).toBe('it.');
  });

  it('passes through anything that is not kana', () => {
    expect(kanaToRomaji('た.べる')).toBe('ta.beru');
  });
});
