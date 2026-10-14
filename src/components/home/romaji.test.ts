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

  it('passes through anything that is not kana', () => {
    expect(kanaToRomaji('た.べる')).toBe('ta.beru');
  });
});
