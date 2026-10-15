// How close a spoken attempt (speech-recognition text) is to the expected sentence.
// Recognizers return a mix of kanji and kana that rarely matches the authored
// spelling exactly, so both the kana reading and the written form are compared
// and the better score wins.

import type { RubyText } from '../lib/types.ts';
import { rubyToKana, rubyToPlain } from '../lib/ruby.ts';

/** Punctuation, symbols and whitespace in any script (。、！？「」・〜 …). */
const IGNORED_RE = /[\p{P}\p{S}\p{Z}\s]/gu;

/**
 * NFKC (full-width ASCII → ASCII, half-width katakana → full-width), lower case,
 * katakana → hiragana, punctuation and spaces removed. Returns code points.
 */
export function normalizeForCompare(s: string): string[] {
  const folded = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(IGNORED_RE, '')
    // ァ..ヶ map onto ぁ..ゖ; ー and other marks are left alone.
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  return Array.from(folded);
}

/** Levenshtein distance over code points, two-row dynamic programming. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function score(expected: string[], heard: string[]): number {
  const longest = Math.max(expected.length, heard.length);
  if (longest === 0) return 1;
  return 1 - editDistance(expected, heard) / longest;
}

/**
 * 0..1 similarity between what should have been said and what was heard.
 * `expected` may carry ruby markup ("{今日|きょう}は"); its kana reading and its
 * written form are both tried against the transcript.
 */
export function similarity(expected: RubyText | string, heard: string): number {
  const said = normalizeForCompare(heard);
  const kana = normalizeForCompare(rubyToKana(expected));
  const plain = normalizeForCompare(rubyToPlain(expected));
  return Math.max(score(kana, said), score(plain, said));
}

/** A spoken answer at least this similar to the word counts as said right. */
export const SPOKEN_MATCH_THRESHOLD = 0.75;

/**
 * Whether a speech-recognition transcript says the expected word. Recognizers write words
 * in kanji or kana as they see fit, so both the written form and every accepted reading are
 * tried: an exact match after normalizing (NFKC, punctuation and spaces dropped, katakana
 * folded to hiragana), or a similarity of at least 0.75 against either.
 */
export function spokenMatches(transcript: string, expected: { written?: string; readings: readonly string[] }): boolean {
  const heard = normalizeForCompare(transcript);
  if (!heard.length) return false;
  const targets = [expected.written, ...expected.readings]
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => normalizeForCompare(rubyToPlain(t)))
    .filter((t) => t.length > 0);
  const said = heard.join('');
  if (targets.some((t) => t.join('') === said)) return true;
  return targets.some((t) => score(t, heard) >= SPOKEN_MATCH_THRESHOLD);
}
