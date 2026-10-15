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

  it("types ー and Japanese punctuation in a hiragana field, as an IME does (QA V061)", () => {
    expect(imeConvert('kono ke-ki ha oishikunaidesu.')).toBe('この けーき は おいしくないです。');
    expect(imeConvert('hai, sou desu ka?')).toBe('はい、 そう です か？');
    expect(imeConvert('sugoi!')).toBe('すごい！');
    // Numbers keep their separators.
    expect(toKana('1,500en')).toBe('1,500えん');
    expect(imeConvert('3.5')).toBe('3.5');
  });

  it('types katakana for syllables written in capitals, so loanwords can be written in a hiragana field', () => {
    expect(imeConvert('kono KE-KI ha oishikunaidesu.')).toBe('この ケーキ は おいしくないです。');
    expect(imeConvert('KO-HI- wo nomu')).toBe('コーヒー を のむ');
    expect(toKana('PAN')).toBe('パン');
    expect(imeConvert('PAN')).toBe('パN');
    expect(imeConvert('KITTE')).toBe('キッテ');
    expect(imeConvert('E-RU')).toBe('エール');
    // A capitalized word is not katakana.
    expect(imeConvert('Ano hito')).toBe('あの ひと');
    expect(imeConvert('Watashi')).toBe('わたし');
    expect(toKana('A')).toBe('あ');
  });

  it('converts capitals live, key by key, without losing the case of an unfinished syllable', () => {
    let field = '';
    for (const key of 'KE-KI desu') field = imeConvert(field + key);
    expect(field).toBe('ケーキ です');
    field = '';
    for (const key of 'AISU') field = imeConvert(field + key);
    expect(field).toBe('アイス');
    field = '';
    for (const key of 'Ano') field = imeConvert(field + key);
    expect(field).toBe('あの');
    expect(imeConvert('K')).toBe('K');
    expect(imeConvert('A')).toBe('A');
  });

  it('keeps a katakana word in katakana when its last capital is a lone syllable typed after the rest', () => {
    const typeKeys = (text: string) => [...text].reduce((field, key) => imeConvert(field + key), '');
    expect(typeKeys('kono PAN ha oishii.')).toBe('この パン は おいしい。');
    expect(typeKeys('RA-MEN ga suki')).toBe('ラーメン が すき');
    expect(typeKeys('WAIN wo nomu')).toBe('ワイン を のむ');
    expect(typeKeys('KAI desu')).toBe('カイ です');
    expect(typeKeys('Ano hito')).toBe('あの ひと');
  });

  it('keeps number separators while typing key by key', () => {
    const typeKeys = (text: string) => [...text].reduce((field, key) => imeConvert(field + key), '');
    expect(typeKeys('1,500en desu.')).toBe('1,500えん です。');
    expect(typeKeys('3.5')).toBe('3.5');
    expect(typeKeys('3, 4')).toBe('3、 4');
    expect(imeConvert('3.')).toBe('3.');
    expect(toKana('3.')).toBe('3。');
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
