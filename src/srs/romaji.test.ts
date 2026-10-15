import { describe, expect, it } from 'vitest';
import { kanaMatches } from './answers.ts';
import { imeConvert, toKana } from './romaji.ts';

describe('toKana', () => {
  it.each([
    ["kon'nichiha", 'こんにちは'],
    ['konnichiha', 'こんにちは'],
    ['kitte', 'きって'],
    ['nn', 'ん'],
    ['shinbun', 'しんぶん'],
    ['minna', 'みんな'],
  ])('%s → %s', (romaji, kana) => {
    expect(toKana(romaji)).toBe(kana);
  });
});

describe('imeConvert', () => {
  it('converts complete syllables while typing and keeps an unfinished tail as letters', () => {
    expect(imeConvert('kit')).toBe('きt');
    expect(imeConvert('ki')).toBe('き');
    expect(imeConvert('kitt')).toBe('きっt');
    expect(imeConvert('kitte')).toBe('きって');
    expect(imeConvert('ky')).toBe('ky');
    expect(imeConvert('kyo')).toBe('きょ');
  });

  it("turns n' and nn into ん and keeps a lone final n while typing", () => {
    expect(imeConvert("kon'")).toBe('こん');
    expect(imeConvert('konn')).toBe('こん');
    expect(imeConvert('kon')).toBe('こn');
    expect(imeConvert('konnichiha')).toBe('こんにちは');
  });

  it('passes kana through, so converting the whole field again is safe', () => {
    expect(imeConvert('きt')).toBe('きt');
    expect(imeConvert('きって')).toBe('きって');
    expect(imeConvert(imeConvert('kitte'))).toBe('きって');
  });

  it('writes katakana on request', () => {
    expect(imeConvert('ko-hi-', { katakana: true })).toBe('コーヒー');
    expect(imeConvert('kar', { katakana: true })).toBe('カr');
  });
});

describe('typed readings', () => {
  it('accepts long-vowel spellings and the おう/おお variants', () => {
    expect(kanaMatches('ookii', ['おおきい'])).toBe(true);
    expect(kanaMatches('toukyou', ['とうきょう'])).toBe(true);
    expect(kanaMatches('tōkyō', ['とうきょう'])).toBe(true);
    expect(kanaMatches('oneesan', ['おねえさん'])).toBe(true);
    // An altKana variant listed by the build (WordInfo.readings).
    expect(kanaMatches('tookyoo', ['とうきょう', 'とおきょお'])).toBe(true);
    expect(kanaMatches('tokyo', ['とうきょう', 'とおきょお'])).toBe(false);
  });
});
