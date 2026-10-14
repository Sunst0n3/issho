import { describe, expect, it } from 'vitest';
import { editDistance, normalizeForCompare, similarity } from './compare.ts';

describe('normalizeForCompare', () => {
  it('folds katakana, width and case, and drops punctuation and spaces', () => {
    expect(normalizeForCompare('コーヒー、ください！').join('')).toBe('こーひーください');
    expect(normalizeForCompare('ｶﾀｶﾅ　ＡＢＣ').join('')).toBe('かたかなabc');
    expect(normalizeForCompare('「はい」・そう〜です？').join('')).toBe('はいそうです');
  });

  it('splits into code points, not UTF-16 units', () => {
    expect(normalizeForCompare('𠮟る')).toEqual(['𠮟', 'る']);
  });
});

describe('editDistance', () => {
  it('counts insertions, deletions and substitutions', () => {
    const d = (a: string, b: string) => editDistance(Array.from(a), Array.from(b));
    expect(d('', '')).toBe(0);
    expect(d('abc', '')).toBe(3);
    expect(d('kitten', 'sitting')).toBe(3);
    expect(d('すし', 'すしや')).toBe(1);
    expect(d('ねこ', 'いぬ')).toBe(2);
  });
});

describe('similarity', () => {
  const sentence = '{明日|あした}は{水曜日|すいようび}です。';

  it('is 1 for an exact match of the written form', () => {
    expect(similarity(sentence, '明日は水曜日です')).toBe(1);
  });

  it('is 1 for an exact match of the reading, in either kana script', () => {
    expect(similarity(sentence, 'あしたはすいようびです')).toBe(1);
    expect(similarity(sentence, 'アシタハスイヨウビデス')).toBe(1);
  });

  it('ignores punctuation and spaces the recognizer adds or drops', () => {
    expect(similarity('はい、そうです。', 'はい そうです')).toBe(1);
  });

  it('gives partial credit for a near miss', () => {
    const s = similarity(sentence, 'あしたはすいようびだ');
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeLessThan(1);
  });

  it('takes the better of the kana and written comparisons', () => {
    // The recognizer wrote 明日 in kanji but 水曜日 in kana: neither form matches
    // exactly, but the score should still be reasonably high.
    expect(similarity(sentence, '明日はすいようびです')).toBeGreaterThan(0.6);
  });

  it('is low for something unrelated', () => {
    expect(similarity(sentence, 'ありがとうございます')).toBeLessThan(0.3);
  });

  it('handles empty input', () => {
    expect(similarity(sentence, '')).toBe(0);
    expect(similarity('', '')).toBe(1);
    expect(similarity('。', '')).toBe(1);
  });

  it('accepts plain strings without ruby', () => {
    expect(similarity('おはよう', 'おはよう')).toBe(1);
  });

  it('stays within 0..1', () => {
    const s = similarity('あ', 'ありがとうございます');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
