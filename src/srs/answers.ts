// Checking answers and turning outcomes into FSRS grades.

import { Rating, type Grade } from 'ts-fsrs';
import { rubyToKana } from '../lib/ruby.ts';
import type { KanaEntry } from '../lib/types.ts';
import { shuffle } from './random.ts';
import { toHiragana, toKana } from './romaji.ts';

export { toHiragana, toKana, toKatakana, type ToKanaOptions } from './romaji.ts';
export { seededRandom, shuffle } from './random.ts';

// ---------------------------------------------------------------------------
// Kana and romaji
// ---------------------------------------------------------------------------

/** Unicode-normalized (full-/half-width folded), trimmed, katakana → hiragana. */
export function normalizeKana(s: string): string {
  return toHiragana(s.normalize('NFKC').trim());
}

function normalizeRomaji(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, '');
}

/**
 * A typed romaji answer for a kana: its Hepburn romaji, a listed alternative,
 * or any spelling an IME would turn into that kana ("si", "tu", "nn").
 */
export function romajiMatches(input: string, kana: KanaEntry): boolean {
  const typed = normalizeRomaji(input);
  if (!typed) return false;
  if ([kana.romaji, ...(kana.altRomaji ?? [])].some((r) => normalizeRomaji(r) === typed)) return true;
  return normalizeKana(toKana(typed)) === normalizeKana(kana.char);
}

/** Kana with spaces, punctuation and long-vowel dash variants folded away. */
function kanaKey(s: string): string {
  return normalizeKana(s)
    .replace(/-/g, 'ー')
    .replace(/[\s、。・,.!?！？「」『』…~〜]/g, '');
}

/** Long vowels toKana reads one way (おう, えい) that can also stand for おお and ええ (ōkii, onēsan). */
const OTHER_LONG_VOWELS: Record<string, readonly string[]> = {
  ō: ['ou', 'oo'], ô: ['ou', 'oo'], ē: ['ei', 'ee'], ê: ['ei', 'ee'],
};
const MAX_SPELLINGS = 32;

/**
 * The romaji spellings a typed answer may stand for: as typed, with ō/ē read
 * either way, and with "nn" before a vowel or y read as ん alone, as IMEs do
 * (kinnyoubi → きんようび; toKana keeps minna → みんな).
 */
function typedSpellings(input: string): string[] {
  let spellings = [''];
  for (const ch of input.normalize('NFKC').toLowerCase()) {
    const options = OTHER_LONG_VOWELS[ch] ?? [ch];
    spellings = spellings.length * options.length > MAX_SPELLINGS
      ? spellings.map((s) => s + options[0])
      : spellings.flatMap((s) => options.map((o) => s + o));
  }
  return [...spellings, ...spellings.map((s) => s.replace(/nn(?=[aiueoy])/g, "n'"))];
}

/**
 * A typed kana answer (kana or romaji) against the expected kana, which may be
 * ruby markup or a list of accepted readings. Hiragana and katakana are equal.
 */
export function kanaMatches(input: string, expected: string | readonly string[]): boolean {
  const typed = new Set(typedSpellings(input).map((s) => kanaKey(toKana(s))));
  typed.delete('');
  if (!typed.size) return false;
  const accepted = typeof expected === 'string' ? [expected] : expected;
  return accepted.some((e) => typed.has(kanaKey(rubyToKana(e))));
}

// ---------------------------------------------------------------------------
// English meanings
// ---------------------------------------------------------------------------

const LEADING_FILLER = /^(?:to|a|an|the)\s+/;

/** Lower-case words only, no punctuation, no leading "to "/"a "/"the ". */
export function normalizeMeaning(s: string): string {
  let out = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  while (LEADING_FILLER.test(out)) out = out.replace(LEADING_FILLER, '');
  return out;
}

/**
 * Normalized forms accepted for one listed meaning: each ';'/'/' alternative,
 * with and without its parenthesised part ("(one's) mother").
 */
function meaningForms(meaning: string): string[] {
  return meaning.split(/[;/]/).flatMap((part) => [
    normalizeMeaning(part.replace(/\([^)]*\)/g, ' ')),
    normalizeMeaning(part),
  ]);
}

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
/** How far each keyboard row is shifted right, in keys. */
const ROW_SHIFT = [0, 0.25, 0.75];

function keyAt(c: string): { row: number; x: number } | undefined {
  const row = KEY_ROWS.findIndex((r) => r.includes(c));
  return row < 0 ? undefined : { row, x: KEY_ROWS[row].indexOf(c) + ROW_SHIFT[row] };
}

/** Keys that touch on a QWERTY keyboard. */
function adjacentKeys(a: string, b: string): boolean {
  const p = keyAt(a);
  const q = keyAt(b);
  if (!p || !q || a === b) return false;
  const dx = Math.abs(p.x - q.x);
  return p.row === q.row ? dx === 1 : Math.abs(p.row - q.row) === 1 && dx < 1;
}

const isVowel = (c: string) => 'aeiou'.includes(c);

/** An extra key hit next to a neighbour: the same letter again, or the key beside it. */
function isStrayKey(typed: string, j: number): boolean {
  return [typed[j - 1], typed[j + 1]].some((n) => n !== undefined && (n === typed[j] || adjacentKeys(n, typed[j])));
}

/**
 * The fewest typing slips that turn `word` into `typed`: a dropped letter, two
 * neighbouring letters swapped, a stray extra key, or a letter replaced by a
 * neighbouring key or another vowel. Other changes (an unrelated letter added
 * or swapped in) are not slips, since they mostly spell a different word:
 * water → waiter or house → horse take several slips; Infinity when impossible.
 */
export function slipCount(word: string, typed: string): number {
  const d = Array.from({ length: word.length + 1 }, () => Array<number>(typed.length + 1).fill(Infinity));
  d[0][0] = 0;
  for (let i = 0; i <= word.length; i++) {
    for (let j = 0; j <= typed.length; j++) {
      if (i > 0) d[i][j] = Math.min(d[i][j], d[i - 1][j] + 1);
      if (j > 0 && isStrayKey(typed, j - 1)) d[i][j] = Math.min(d[i][j], d[i][j - 1] + 1);
      if (i > 0 && j > 0) {
        const [a, b] = [word[i - 1], typed[j - 1]];
        const cost = a === b ? 0 : adjacentKeys(a, b) || (isVowel(a) && isVowel(b)) ? 1 : Infinity;
        d[i][j] = Math.min(d[i][j], d[i - 1][j - 1] + cost);
      }
      if (i > 1 && j > 1 && word[i - 1] === typed[j - 2] && word[i - 2] === typed[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[word.length][typed.length];
}

/** Slips forgiven per word: none under 5 letters, 1 up to 9, 2 from 10. */
function typoAllowance(word: string): number {
  return word.length >= 10 ? 2 : word.length >= 5 ? 1 : 0;
}

/**
 * Changing a word's first or last letter mostly makes another word (right →
 * night, eighty → eight, sixty → sixth), so both must stay; only the last two
 * letters may be swapped (watre).
 */
function sameEnds(typed: string, word: string): boolean {
  const last = typed.at(-1) === word.at(-1) || (typed.at(-1) === word.at(-2) && typed.at(-2) === word.at(-1));
  return typed[0] === word[0] && last;
}

/** Plain plurals of a word: mountains, boxes, cities. */
function pluralsOf(word: string): string[] {
  return [word + 's', word + 'es', ...(/[^aeiou]y$/.test(word) ? [word.slice(0, -1) + 'ies'] : [])];
}

/**
 * One word the plain plural of the other ("mountains" for "mountain", or
 * "vegetable" for "vegetables"): the same answer, not a slip, so the last
 * letter may change. Words under 3 letters are left out ("as" ≠ "a").
 */
function isPluralPair(a: string, b: string): boolean {
  return (b.length >= 3 && pluralsOf(b).includes(a)) || (a.length >= 3 && pluralsOf(a).includes(b));
}

/** A typo of `form`, word by word, so a short word in a phrase must be exact ("west exit" ≠ "east exit"). */
function isTypoOf(typed: string, form: string): boolean {
  const typedWords = typed.split(' ');
  const words = form.split(' ');
  if (typedWords.length !== words.length) return false;
  return words.every((word, i) => {
    const t = typedWords[i];
    if (t === word || isPluralPair(t, word)) return true;
    const allowance = typoAllowance(word);
    return allowance > 0 && sameEnds(t, word) && slipCount(word, t) <= allowance;
  });
}

export interface MeaningMatchOptions {
  /**
   * Meanings of other items that must not be accepted as a typo (or plural) of
   * this one, e.g. "block" when the answer is "black". Pass every other item's
   * meanings, not only the ones on screen.
   */
  notAccepted?: readonly string[];
}

export function meaningMatches(input: string, meanings: readonly string[], opts: MeaningMatchOptions = {}): boolean {
  const typed = normalizeMeaning(input);
  if (!typed) return false;
  const forms = meanings.flatMap(meaningForms).filter(Boolean);
  const unspaced = (s: string) => s.replace(/ /g, '');
  if (forms.some((f) => f === typed || unspaced(f) === unspaced(typed))) return true;
  if (opts.notAccepted?.some((m) => meaningForms(m).includes(typed))) return false;
  return forms.some((f) => isTypoOf(typed, f));
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export interface AnswerOutcome {
  correct: boolean;
  usedHint?: boolean;
  /** Wrong attempts before the final answer. */
  retries?: number;
}

/** Objective cards: right first try → Good; right after a hint or retry → Hard; wrong → Again. */
export function gradeFor({ correct, usedHint = false, retries = 0 }: AnswerOutcome): Grade {
  if (!correct) return Rating.Again;
  return usedHint || retries > 0 ? Rating.Hard : Rating.Good;
}

export interface WritingOutcome {
  /** Wrong stroke attempts. */
  mistakes: number;
  hintsUsed: number;
  strokeCount: number;
  gaveUp: boolean;
  /**
   * Strokes not right first time (WritingPad reports it). Without it every
   * mistake is assumed to be on a different stroke.
   */
  failedStrokes?: number;
}

/**
 * Writing cards: clean → Good; any hint or 2+ stroke retries → Hard; gave up or
 * more than half the strokes missed → Again.
 */
export function gradeForWriting({ mistakes, hintsUsed, strokeCount, gaveUp, failedStrokes }: WritingOutcome): Grade {
  const failed = failedStrokes ?? Math.min(mistakes, strokeCount);
  if (gaveUp || failed > strokeCount / 2) return Rating.Again;
  return hintsUsed > 0 || mistakes >= 2 ? Rating.Hard : Rating.Good;
}

// ---------------------------------------------------------------------------
// Multiple choice
// ---------------------------------------------------------------------------

/**
 * Up to `n` options: the correct one plus distractors from `pool`, all distinct
 * by `key`, in random order. Pass a seeded `random` for reproducible options.
 */
export function choicesFrom<T>(
  correct: T,
  pool: readonly T[],
  n: number,
  key: (item: T) => string,
  random: () => number = Math.random,
): T[] {
  const seen = new Set([key(correct)]);
  const options: T[] = [];
  for (const item of shuffle(pool, random)) {
    if (options.length >= n - 1) break;
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    options.push(item);
  }
  options.splice(Math.floor(random() * (options.length + 1)), 0, correct);
  return options;
}
