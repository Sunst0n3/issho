import { describe, expect, it } from 'vitest';
import { furiganaPolicy, matureKeysFrom, matureRefsFrom } from './hooks.ts';
import type { CardRecord } from './types.ts';

const read = (itemId: string, stability: number, patch: Partial<CardRecord> = {}) =>
  ({ itemId, kind: itemId.startsWith('core:') ? 'core' : 'word', type: 'read', stability, ...patch }) as CardRecord;

const WORDS: Record<string, { written: string; kana: string }> = {
  'word:1': { written: '日本', kana: 'にほん' },
  'word:2': { written: '食べる', kana: 'たべる' },
  'core:cw-0044': { written: '人', kana: 'ひと' },
};

function policyFor(cards: CardRecord[], setting: 'always' | 'unknown' | 'never' = 'unknown') {
  const refs = matureRefsFrom(cards);
  return furiganaPolicy(setting, new Set(refs), matureKeysFrom(refs, (ref) => WORDS[ref]));
}

describe('furiganaPolicy', () => {
  it('hides the reading of a word whose read card is mature (21 days or more)', () => {
    expect(policyFor([read('word:1', 22)]).forRef('word:1', true)).toBe(false);
    expect(policyFor([read('word:1', 20)]).forRef('word:1', true)).toBe(true);
    expect(policyFor([read('word:1', 22, { suspended: 'retired' })]).forRef('word:1', true)).toBe(true);
    expect(policyFor([read('word:1', 22, { type: 'produce' })]).forRef('word:1', true)).toBe(true);
    expect(policyFor([]).forRef(undefined, true)).toBe(true);
  });

  it('shows no reading over kana and always shows names', () => {
    const policy = policyFor([read('word:1', 30)]);
    expect(policy.forRef('word:9', false)).toBe(false);
    expect(policy.forRef(undefined, true, true)).toBe(true);
    expect(policy.forRef('word:1', true, true)).toBe(true);
  });

  it('gives two learners different furigana for the same token', () => {
    const mine = policyFor([read('word:1', 30)]);
    const partner = policyFor([read('word:1', 5)]);
    expect(mine.forRef('word:1', true)).toBe(false);
    expect(partner.forRef('word:1', true)).toBe(true);
  });

  it('follows the always and never settings', () => {
    expect(policyFor([read('word:1', 30)], 'always').forRef('word:1', true)).toBe(true);
    expect(policyFor([read('word:1', 30)], 'always').forRuby('日本', 'にほん')).toBe(true);
    expect(policyFor([], 'never').forRef('word:1', true)).toBe(false);
    expect(policyFor([], 'never').forRuby('日本', 'にほん')).toBe(false);
  });

  it('hides ruby of a mature word, also across okurigana', () => {
    const policy = policyFor([read('word:1', 30), read('word:2', 30), read('core:cw-0044', 30)]);
    expect(policy.forRuby('日本', 'にほん')).toBe(false);
    expect(policy.forRuby('人', 'ひと')).toBe(false);
    expect(policy.forRuby('食', 'た')).toBe(false); // {食|た}べる
    expect(policy.forRuby('食', 'しょく')).toBe(true);
    expect(policy.forRuby('日', 'ひ')).toBe(true);
    expect(policy.forRuby('人', 'にん')).toBe(true);
  });
});
