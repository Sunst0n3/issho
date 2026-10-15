import { describe, expect, it, vi } from 'vitest';
import type { WordInfo } from '../../lib/data.ts';
import type { CoreWord } from '../../lib/types.ts';
import { seededRandom } from '../../srs/random.ts';
import { glossQuestion, shortGloss } from './readingQuestion.ts';

const core = (id: string, kana: string, en: string, pos: CoreWord['pos'] = 'demonstrative'): CoreWord =>
  ({ id, order: 1, kana, en, pos, register: 'both', topic: 'basics', use: true, kanji: [], unit: 1 });

// The demonstratives as core-words.json glosses them: many share a sense ('that', 'over there').
const CORE: CoreWord[] = [
  core('cw-0092', 'これ', 'this (one, near me)'),
  core('cw-0093', 'それ', 'that (one, near you)'),
  core('cw-0094', 'あれ', 'that (one, over there)'),
  core('cw-0095', 'この', 'this ~ (before a noun)'),
  core('cw-0096', 'その', 'that ~ (near you)'),
  core('cw-0097', 'あの', 'that ~ (over there)'),
  core('cw-0099', 'どの', 'which ~?'),
  core('cw-0105', 'ここ', 'here'),
  core('cw-0107', 'そこ', 'there (near you)'),
  core('cw-0108', 'あそこ', 'over there'),
  core('cw-0200', 'たべる', 'to eat', 'verb-ru'),
  core('cw-0201', 'みず', 'water', 'noun'),
  core('cw-0202', 'おおきい', 'big', 'adj-i'),
];

vi.mock('../../lib/data.ts', () => ({
  loadCoreWords: async () => CORE,
  loadWordInfo: async () => (ref: string): WordInfo | undefined => {
    const c = CORE.find((w) => `core:${w.id}` === ref);
    return c && { ref: `core:${c.id}`, written: c.kana, kana: c.kana, en: c.en, kanji: [], use: true, readings: [c.kana], core: c };
  },
}));

const senses = (en: string) => en.split(/[;,()~?]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

describe('guess-first gloss (V060)', () => {
  it('keeps the qualifier and drops the ~ placeholder', () => {
    expect(shortGloss('that ~ (over there)')).toBe('that (over there)');
    expect(shortGloss('this (one, near me)')).toBe('this (one, near me)');
    expect(shortGloss('which ~?')).toBe('which?');
    expect(shortGloss('to eat; to live on')).toBe('to eat');
    expect(shortGloss('healthy, well')).toBe('healthy');
    expect(shortGloss('(my) husband')).toBe('(my) husband');
  });

  it('never offers a wrong option that shares a sense with the answer or with another option', async () => {
    const known = { isKnown: () => true, introducedDay: () => '2026-10-01' };
    for (let seed = 0; seed < 40; seed++) {
      const q = (await glossQuestion('core:cw-0097', 'あの', known, seededRandom(seed)))!;
      expect(q.answer).toBe('that (over there)');
      expect(q.options).toHaveLength(3);
      expect(q.options.join(' ')).not.toMatch(/[~〜]/);
      const seen = new Set<string>();
      for (const option of q.options) {
        for (const sense of senses(option)) {
          expect(seen.has(sense), `${q.options.join(' | ')} share "${sense}"`).toBe(false);
          seen.add(sense);
        }
      }
      expect(q.options).not.toContain('over there');
    }
  });
});
