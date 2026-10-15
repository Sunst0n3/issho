import { describe, expect, it } from 'vitest';
import { grammarGloss } from './format.ts';

describe('grammarGloss', () => {
  it('drops a name that only repeats the pattern shown above it', () => {
    expect(grammarGloss({ title: '〜は〜です — "X is Y"', pattern: '〜は〜です' })).toBe('"X is Y"');
    // Latin letters in the name, but the name is the pattern itself (V051 item 4).
    expect(grammarGloss({ title: 'AかB・〜にします — "A or B", "I\'ll have …"', pattern: 'AかB・〜にします' })).toBe('"A or B", "I\'ll have …"');
    expect(grammarGloss({ title: '〜に{行|い}きます — "go to do"', pattern: '〜に{行|い}きます' })).toBe('"go to do"');
  });

  it('keeps a name in English words, which says what the pattern does not', () => {
    expect(grammarGloss({ title: 'い-adjectives — "it is …"', pattern: '〜いです・〜くないです' })).toBe('い-adjectives — "it is …"');
    expect(grammarGloss({ title: 'Dictionary form', pattern: '食べる・飲む' })).toBe('Dictionary form');
  });
});
