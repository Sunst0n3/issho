// The question asked about a reading sentence: how to read one word in it, or,
// when no word is made of known kanji only, what it means.

import { loadSentences } from '../../lib/data.ts';
import { isKanji, parseRuby } from '../../lib/ruby.ts';
import { knownKanji } from '../../srs/progress.ts';
import { meaningOptions, readingOptions } from './cards/prepare.ts';
import type { SentenceLike } from './sentences.ts';

export type ReadingQuestion =
  /** `target` is the index of the underlined ruby segment. */
  | { kind: 'reading'; target: number; answer: string; options: string[] }
  | { kind: 'meaning'; answer: string; options: string[] };

/** Kanji learned most recently count as "recent" for picking the underlined word. */
const RECENT_KANJI = 20;

/**
 * The ruby segment to ask about: of the words whose kanji are all known (a new
 * kanji, the "+1", keeps its furigana), the one with the most recently learned
 * kanji, else the first. -1 when there is none.
 */
export function pickTarget(jp: string, recent: readonly string[], known: ReadonlySet<string>): number {
  const rank = new Map(recent.map((k, i) => [k, recent.length - i]));
  let best = -1;
  let bestScore = -1;
  parseRuby(jp).forEach((seg, i) => {
    if (seg.reading === undefined) return;
    const kanji = [...seg.text].filter(isKanji);
    if (kanji.some((ch) => !known.has(ch))) return;
    const score = Math.max(0, ...kanji.map((ch) => rank.get(ch) ?? 0));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export async function prepareReading(sentence: SentenceLike, random: () => number = Math.random): Promise<ReadingQuestion> {
  const known = await knownKanji();
  const recent = known.slice(-RECENT_KANJI).reverse();
  const target = pickTarget(sentence.jp, recent, new Set(known));
  if (target >= 0) {
    const seg = parseRuby(sentence.jp)[target];
    const answer = seg.reading ?? seg.text;
    const options = await readingOptions(answer, { kanji: [...seg.text].filter(isKanji), written: seg.text }, random);
    return { kind: 'reading', target, answer, options };
  }
  const others = (await loadSentences()).filter((s) => s.id !== sentence.id && s.en !== sentence.en);
  const len = sentence.en.length;
  const similar = others.filter((s) => Math.abs(s.en.length - len) <= 12);
  const options = meaningOptions([sentence.en], [similar.map((s) => [s.en]), others.map((s) => [s.en])], random);
  return { kind: 'meaning', answer: sentence.en, options };
}
