// The question asked about a reading sentence: how to read one word in it, or,
// when no word is made of known kanji only, what it means.

import { loadSentences, loadWords } from '../../lib/data.ts';
import { isKanji, parseRuby, type RubySegment } from '../../lib/ruby.ts';
import type { WordEntry } from '../../lib/types.ts';
import { toHiragana } from '../../srs/answers.ts';
import { knownKanji } from '../../srs/progress.ts';
import { meaningOptions, readingOptions } from './cards/prepare.ts';
import type { SentenceLike } from './sentences.ts';

/**
 * The underlined word: ruby segments `start` to `start + count - 1`, plus the
 * first `tail` characters of the plain text after them (okurigana: the い of 高い).
 */
export interface ReadingTarget {
  start: number;
  count: number;
  tail: number;
}

export type ReadingQuestion =
  | {
      kind: 'reading';
      target: ReadingTarget;
      /** The underlined word as written: 高い. */
      written: string;
      /** Its whole reading: たかい. */
      answer: string;
      options: string[];
      /** The dictionary word it is, when known (for its meaning). */
      word?: WordEntry;
    }
  | { kind: 'meaning'; answer: string; options: string[] };

/** Kanji learned most recently count as "recent" for picking the underlined word. */
const RECENT_KANJI = 20;
/** Kana after a ruby segment looked at for okurigana. */
const MAX_TAIL = 4;
/** Ruby segments that may make up one word ({学生|がくせい}{時代|じだい}). */
const MAX_SEGMENTS = 3;
const KANA = /^[ぁ-ゖァ-ヺー]$/u;

/** Dictionary words by spelling and by reading (in hiragana). */
export interface WordLookup {
  byWritten: ReadonlyMap<string, readonly WordEntry[]>;
  byKana: ReadonlyMap<string, readonly WordEntry[]>;
}

/** Built once per word list (the loader caches it); a list that grew is indexed again. */
const lookups = new WeakMap<readonly WordEntry[], WordLookup & { size: number }>();

export function wordLookup(words: readonly WordEntry[]): WordLookup {
  let lookup = lookups.get(words);
  if (!lookup || lookup.size !== words.length) {
    const byWritten = new Map<string, WordEntry[]>();
    const byKana = new Map<string, WordEntry[]>();
    const add = (map: Map<string, WordEntry[]>, key: string, w: WordEntry) => {
      const list = map.get(key);
      if (list) list.push(w);
      else map.set(key, [w]);
    };
    for (const w of words) {
      add(byWritten, w.written, w);
      add(byKana, toHiragana(w.kana), w);
    }
    lookup = { byWritten, byKana, size: words.length };
    lookups.set(words, lookup);
  }
  return lookup;
}

/**
 * A lone particle after a word belongs to the sentence, not the word: 山が is
 * "the mountain (subject)", not the rare 山が "mountain villa"; 一人で, not 一人です.
 */
const PARTICLES = new Set([...'がをにへでともはのやかねよ']);

/**
 * The dictionary word written `base` + `tail` and read `reading` + `tail`:
 * 高 + い read たか + い is 高い. A reading stopped by a small っ ({一|いっ}ぱい)
 * is finished by its kana even when the dictionary spells that part in kanji
 * (一杯).
 */
function dictionaryWord(lookup: WordLookup, base: string, reading: string, tail: string): WordEntry | undefined {
  if (PARTICLES.has(tail)) return undefined;
  const kana = toHiragana(reading + tail);
  const exact = lookup.byWritten.get(base + tail)?.find((w) => toHiragana(w.kana) === kana);
  if (exact || !tail || !/[っッ]$/.test(reading)) return exact;
  return lookup.byKana.get(kana)?.find((w) => w.written.startsWith(base) && [...w.written.slice(base.length)].some(isKanji));
}

export interface ResolvedWord {
  target: ReadingTarget;
  written: string;
  answer: string;
  word?: WordEntry;
  /**
   * Readings that are not the word's but would look like it in the options:
   * the reading with more or less of the following kana (たか and たかいで for 高い).
   */
  nearMisses: string[];
}

/**
 * The whole word that starts at ruby segment `start`: the longest run of that
 * segment, the segments right after it (all kanji known) and the kana after
 * them that the dictionary spells as one word. Without a dictionary match it
 * is the segment alone.
 */
/** The kana a plain segment starts with, at most MAX_TAIL ('いですね。' → い, で, す, ね). */
function leadingKana(seg: RubySegment | undefined): string[] {
  const kana: string[] = [];
  if (!seg || seg.reading !== undefined) return kana;
  for (const ch of seg.text) {
    if (!KANA.test(ch) || kana.length >= MAX_TAIL) break;
    kana.push(ch);
  }
  return kana;
}

export function resolveWord(segs: readonly RubySegment[], start: number, known: ReadonlySet<string>, lookup: WordLookup): ResolvedWord {
  const first = segs[start];
  let best = { count: 1, tail: '', word: undefined as WordEntry | undefined, length: 0 };
  let base = '';
  let reading = '';
  for (let count = 1; count <= MAX_SEGMENTS; count++) {
    const seg = segs[start + count - 1];
    if (!seg || seg.reading === undefined) break;
    if (count > 1 && [...seg.text].some((ch) => isKanji(ch) && !known.has(ch))) break;
    base += seg.text;
    reading += seg.reading;
    const kana = leadingKana(segs[start + count]);
    for (let n = 0; n <= kana.length; n++) {
      const tail = kana.slice(0, n).join('');
      const word = dictionaryWord(lookup, base, reading, tail);
      const length = [...base].length + n;
      if (word && length >= best.length) best = { count, tail, word, length };
    }
  }

  const words = segs.slice(start, start + best.count);
  const written = words.map((s) => s.text).join('') + best.tail;
  const answer = words.map((s) => s.reading ?? s.text).join('') + best.tail;
  // The kana after the word's kanji, to leave out readings that run on into it or stop short of it.
  const following = leadingKana(segs[start + best.count]);
  const ownReading = first.reading ?? first.text;
  const nearMisses = new Set<string>();
  for (let n = 0; n <= following.length; n++) {
    const runOn = following.slice(0, n).join('');
    nearMisses.add(ownReading + runOn);
    nearMisses.add(answer.slice(0, answer.length - best.tail.length) + runOn);
  }
  nearMisses.delete(answer);
  return {
    target: { start, count: best.count, tail: [...best.tail].length },
    written,
    answer,
    ...(best.word ? { word: best.word } : {}),
    nearMisses: [...nearMisses].map(toHiragana).filter((r) => r !== toHiragana(answer)),
  };
}

/**
 * A reading that can't be asked on its own: it stops on a small っ that only
 * the next sound completes ({一|いっ}ぱい when the dictionary doesn't know the word).
 */
function isFragment(resolved: ResolvedWord): boolean {
  return !resolved.word && /[っッ]$/.test(resolved.answer);
}

/**
 * The ruby segment to ask about: of the words whose kanji are all known (a new
 * kanji, the "+1", keeps its furigana), the one with the most recently learned
 * kanji, else the first. -1 when there is none. `usable` can rule segments out.
 */
export function pickTarget(
  jp: string,
  recent: readonly string[],
  known: ReadonlySet<string>,
  usable: (index: number) => boolean = () => true,
): number {
  const rank = new Map(recent.map((k, i) => [k, recent.length - i]));
  let best = -1;
  let bestScore = -1;
  parseRuby(jp).forEach((seg, i) => {
    if (seg.reading === undefined) return;
    const kanji = [...seg.text].filter(isKanji);
    if (kanji.some((ch) => !known.has(ch))) return;
    if (!usable(i)) return;
    const score = Math.max(0, ...kanji.map((ch) => rank.get(ch) ?? 0));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export async function prepareReading(sentence: SentenceLike, random: () => number = Math.random): Promise<ReadingQuestion> {
  const [known, words] = await Promise.all([knownKanji(), loadWords()]);
  const knownSet = new Set(known);
  const recent = known.slice(-RECENT_KANJI).reverse();
  const segs = parseRuby(sentence.jp);
  const lookup = wordLookup(words);
  const resolved = new Map<number, ResolvedWord>();
  const resolve = (i: number) => {
    let r = resolved.get(i);
    if (!r) {
      r = resolveWord(segs, i, knownSet, lookup);
      resolved.set(i, r);
    }
    return r;
  };
  const target = pickTarget(sentence.jp, recent, knownSet, (i) => !isFragment(resolve(i)));
  if (target >= 0) {
    const r = resolve(target);
    const kanji = segs.slice(target, target + r.target.count).flatMap((s) => [...s.text].filter(isKanji));
    const options = await readingOptions(r.answer, { kanji, written: r.written, exclude: r.nearMisses }, random);
    return { kind: 'reading', target: r.target, written: r.written, answer: r.answer, options, ...(r.word ? { word: r.word } : {}) };
  }
  const others = (await loadSentences()).filter((s) => s.id !== sentence.id && s.en !== sentence.en);
  const len = sentence.en.length;
  const similar = others.filter((s) => Math.abs(s.en.length - len) <= 12);
  const options = meaningOptions([sentence.en], [similar.map((s) => [s.en]), others.map((s) => [s.en])], random);
  return { kind: 'meaning', answer: sentence.en, options };
}
