import { describe, expect, it } from 'vitest';
import { REAL_KANA } from '../srs/test-fixtures.ts';
import { isKanaOnly, isKanji, kanjiIn, parseRuby, romajiHelper, rubyToKana, rubyToPlain, validateRuby } from './ruby.ts';

describe('ruby markup', () => {
  it('parses, flattens and lists kanji', () => {
    const src = '{明日|あした}は{水曜日|すいようび}です。';
    expect(parseRuby(src)).toEqual([
      { text: '明日', reading: 'あした' },
      { text: 'は' },
      { text: '水曜日', reading: 'すいようび' },
      { text: 'です。' },
    ]);
    expect(rubyToPlain(src)).toBe('明日は水曜日です。');
    expect(rubyToKana(src)).toBe('あしたはすいようびです。');
    expect(kanjiIn(src)).toEqual(['明', '日', '水', '曜']);
  });

  it('validates readings and braces', () => {
    expect(validateRuby('{食|た}べる')).toEqual([]);
    expect(validateRuby('食べる')).toEqual(['kanji "食" has no reading']);
    expect(validateRuby('{食|ta}べる')).toEqual(['reading "ta" for "食" is not kana']);
    expect(validateRuby('{食|た べる')).toContain('unbalanced or malformed ruby braces');
  });

  it('tells kanji and kana apart', () => {
    expect(isKanji('水')).toBe(true);
    expect(isKanji('々')).toBe(false);
    expect(isKanaOnly('カタカナ・ひらがな')).toBe(true);
    expect(isKanaOnly('水')).toBe(false);
  });
});

describe('romajiHelper', () => {
  /** Basic kana of sprint days 1–3 (あ–こ, さ–と, な–ほ). */
  const day3 = new Set([...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ']);

  it('shows romaji only over kana not yet taught', () => {
    expect(romajiHelper('ありがとう', day3, REAL_KANA)).toEqual([
      { text: 'あ' },
      { text: 'り', romaji: 'ri' },
      { text: 'が', romaji: 'ga' },
      { text: 'とう' },
    ]);
  });

  it('keeps yōon and small-kana pairs together, and leaves っ and ー alone', () => {
    expect(romajiHelper('きょうはいっしょ', day3, REAL_KANA)).toEqual([
      { text: 'きょ', romaji: 'kyo' },
      { text: 'うはいっ' },
      { text: 'しょ', romaji: 'sho' },
    ]);
    expect(romajiHelper('コーヒー', new Set(), REAL_KANA)).toEqual([
      { text: 'コ', romaji: 'ko' },
      { text: 'ー' },
      { text: 'ヒ', romaji: 'hi' },
      { text: 'ー' },
    ]);
  });

  it('counts voiced and yōon kana as taught once their rule is, and reads extended katakana', () => {
    expect(romajiHelper('ぎゅうにゅう', new Set(['ぎゅ', 'にゅ', 'う']), REAL_KANA)).toEqual([{ text: 'ぎゅうにゅう' }]);
    expect(romajiHelper('パーティー', new Set(['パ']), REAL_KANA)).toEqual([
      { text: 'パー' },
      { text: 'ティ', romaji: 'ti' },
      { text: 'ー' },
    ]);
  });

  it('passes non-kana through', () => {
    expect(romajiHelper('日本へ！', day3, REAL_KANA)).toEqual([{ text: '日本へ！' }]);
    expect(romajiHelper('日本まで！', day3, REAL_KANA)).toEqual([
      { text: '日本' },
      { text: 'ま', romaji: 'ma' },
      { text: 'で', romaji: 'de' },
      { text: '！' },
    ]);
  });
});
