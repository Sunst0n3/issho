// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cleanGloss, cleanGlosses } from './lib/gloss.ts';
import { cleanKanjiMeanings, cleanReadings, kunReadings, onReadings } from './lib/kanjidic.ts';

describe('cleanGloss', () => {
  it('drops parenthetical notes', () => {
    expect(cleanGloss('water (esp. cool or cold)')).toBe('water');
    expect(cleanGloss("(one's) mother")).toBe('mother');
    expect(cleanGloss('to hang up (e.g. a coat, a picture on the wall)')).toBe('to hang up');
    expect(cleanGloss('counter for (small) animals')).toBe('counter for animals');
  });

  it('handles nested parentheses and tidies punctuation', () => {
    expect(cleanGloss('child (of a (young) age)')).toBe('child');
    expect(cleanGloss('thank you (very much) !')).toBe('thank you!');
  });

  it('keeps the contents when the gloss is only a parenthetical', () => {
    expect(cleanGloss('(something)')).toBe('something');
  });

  it('keeps a leading negation or question word, which carries the meaning', () => {
    expect(cleanGloss('(not) at all')).toBe('not at all');
    expect(cleanGloss('(not) always')).toBe('not always');
    expect(cleanGloss('(nothing) at all')).toBe('nothing at all');
    expect(cleanGloss('(how) many times')).toBe('how many times');
    expect(cleanGloss('(what) the heck')).toBe('what the heck');
    expect(cleanGloss('(not) very (much)')).toBe('not very');
  });
});

describe('cleanGlosses', () => {
  it('keeps at most three distinct glosses', () => {
    expect(cleanGlosses(['to see', 'to look', 'to watch', 'to view', 'to observe'])).toEqual([
      'to see',
      'to look',
      'to watch',
    ]);
    expect(cleanGlosses(['house', 'House (building)', 'home'])).toEqual(['house', 'home']);
  });

  it('prefers short glosses but never returns nothing', () => {
    const long = 'local specialty or souvenir bought as a gift while traveling';
    expect(cleanGlosses([long, 'souvenir'])).toEqual(['souvenir']);
    expect(cleanGlosses([long])).toEqual([long]);
    expect(cleanGlosses([])).toEqual([]);
  });
});

describe('KANJIDIC clean-up', () => {
  it('removes radical housekeeping but keeps clarifications', () => {
    expect(cleanKanjiMeanings(['one', 'one radical (no.1)'])).toEqual(['one']);
    expect(cleanKanjiMeanings(['spring', 'spring (season)', '(kokuji)'])).toEqual(['spring', 'spring (season)']);
    expect(cleanKanjiMeanings(['a', 'b', 'c', 'd', 'e'])).toHaveLength(4);
  });

  it('strips affix hyphens from readings and de-duplicates', () => {
    expect(cleanReadings(['みず', 'みず-', '-ジ'])).toEqual(['みず', 'ジ']);
  });

  it('keeps only katakana on readings and hiragana kun readings', () => {
    expect(onReadings(['シ', '-シ', 'し'])).toEqual(['シ']);
    expect(kunReadings(['こころざ.す', 'こころざし', 'シリング'])).toEqual(['こころざ.す', 'こころざし']);
    expect(kunReadings(['こ', '-こ', 'デシメートル'])).toEqual(['こ']);
  });
});
