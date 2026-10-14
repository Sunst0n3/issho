// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cleanGloss, cleanGlosses } from './lib/gloss.ts';
import { LEAD_MEANINGS, cleanKanjiMeanings, cleanReadings, kunReadings, onReadings } from './lib/kanjidic.ts';

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

  it('names powers of ten and symbols, and drops the ones without an everyday name', () => {
    expect(cleanKanjiMeanings(['capital', '10**16'])).toEqual(['capital', 'ten quadrillion']);
    expect(cleanKanjiMeanings(['portent', '10**12', 'trillion', 'sign'])).toEqual(['portent', 'trillion', 'sign']);
    expect(cleanKanjiMeanings(['correct', 'justice', '10**40'])).toEqual(['correct', 'justice']);
    expect(cleanKanjiMeanings(['ratio', 'rate', 'proportion', '%'])).toEqual(['ratio', 'rate', 'proportion', 'percent']);
    expect(cleanKanjiMeanings(['ten thousand', '10,000'])).toEqual(['ten thousand']);
  });

  it('drops zodiac hours and units, and strips arithmetic notes', () => {
    expect(cleanKanjiMeanings(['child', 'sign of the rat', '11PM-1AM', 'first sign of Chinese zodiac'])).toEqual([
      'child',
      'sign of the rat',
      'first sign of Chinese zodiac',
    ]);
    expect(cleanKanjiMeanings(['monkey sign', '3-5PM'])).toEqual(['monkey sign']);
    expect(cleanKanjiMeanings(['axe', '1.32 lb', 'catty'])).toEqual(['axe', 'catty']);
    expect(cleanKanjiMeanings(['volume', 'product (x*y)', 'acreage'])).toEqual(['volume', 'product', 'acreage']);
    expect(cleanKanjiMeanings(['second (1/60 minute)'])).toEqual(['second']);
    expect(cleanKanjiMeanings(['latitude', '(parallels of) latitude'])).toEqual(['latitude', '(parallels of) latitude']);
  });

  it('spells out abbreviations and ampersands', () => {
    expect(cleanKanjiMeanings(['Inst.', 'institution', 'temple'])).toEqual(['institution', 'temple']);
    expect(cleanKanjiMeanings(['No.', 'residence'])).toEqual(['number (ordinal)', 'residence']);
    expect(cleanKanjiMeanings(['limb', 'arms & legs'])).toEqual(['limb', 'arms and legs']);
  });

  it('puts a hand-picked lead meaning first, merging its other spelling', () => {
    expect(cleanKanjiMeanings(['exam', 'school', 'printing', 'proof', 'correction'], 'school')).toEqual([
      'school',
      'exam',
      'printing',
      'proof',
    ]);
    expect(cleanKanjiMeanings(['-times', 'round', 'game'], 'times')).toEqual(['times', 'round', 'game']);
    expect(cleanKanjiMeanings(['wherefore', 'a reason'], 'reason')).toEqual(['reason', 'wherefore']);
    expect(cleanKanjiMeanings(['lamp', 'a light', 'light'])).toEqual(['lamp', 'light']);
    expect(LEAD_MEANINGS['校']).toBe('school');
  });

  it('never gives two kanji the same hand-picked lead meaning', () => {
    const leads = Object.values(LEAD_MEANINGS).map((m) => m.toLowerCase());
    expect(leads.filter((m, i) => leads.indexOf(m) !== i)).toEqual([]);
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
