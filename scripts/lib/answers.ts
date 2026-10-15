// Accepted typed answers for grammar build items (GrammarBuildItem.answers): the hiragana of the
// sentence and of each alternative, with the particles は/へ/を also accepted as typed by sound
// (わ/え/お). See TECH-DESIGN §3.6.4.

import type { GrammarBuildItem } from '../../src/lib/types.ts';
import type { RubyToken } from '../v2/tokenize.ts';

export const MAX_ANSWERS = 16;

/** The particle spellings a learner may type by sound. */
const PARTICLE_SOUND: Readonly<Record<string, string>> = { は: 'わ', へ: 'え', を: 'お' };

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/u;
/** Punctuation, symbols and spaces; ー is a letter (Lm) and stays. */
const STRIP_RE = /[\p{P}\p{S}\s]/gu;
/** Digits and Latin letters: answers are typed as kana, and the reading of 10分 (じゅっぷん) is not in the tokens. */
const NOT_KANA_RE = /[0-9A-Za-z]/;
const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

/** An answer as the learner types it: hiragana, without punctuation or spaces. */
export function normalizeAnswer(s: string): string {
  return toHiragana(s.normalize('NFKC')).replace(STRIP_RE, '');
}

/**
 * The readings of a tokenized text as answer strings: the plain reading first, then the variants
 * with は/へ/を particles typed as わ/え/お. Undefined when a word could not be read (kanji left in
 * its reading).
 */
export function tokenAnswers(tokens: readonly Pick<RubyToken, 'surface' | 'reading' | 'pos'>[]): string[] | undefined {
  let readings = [''];
  for (const t of tokens) {
    const reading = KANJI_RE.test(t.surface) ? t.reading : t.surface;
    if (!reading || KANJI_RE.test(reading)) return undefined;
    const sound = t.pos === '助詞' ? PARTICLE_SOUND[t.surface] : undefined;
    const options = sound ? [reading, sound] : [reading];
    readings = readings.flatMap((r) => options.map((o) => r + o));
    if (readings.length > MAX_ANSWERS) readings = readings.slice(0, MAX_ANSWERS);
  }
  return [...new Set(readings.map(normalizeAnswer))].filter(Boolean);
}

/**
 * GrammarBuildItem.answers for one item: the plain reading of `jp` and of each alternative first,
 * then their particle variants; deduplicated, at most 16. An alternative that cannot be read is
 * left out and returned in `unread`; one written with digits ('300円です') adds no answers, since
 * the sentence's own reading already gives the kana a learner types.
 */
export function buildAnswers(
  item: Pick<GrammarBuildItem, 'jp' | 'alternatives'>,
  tokenize: (text: string) => readonly Pick<RubyToken, 'surface' | 'reading' | 'pos'>[],
  fallback: (text: string) => string,
): { answers: string[]; unread: string[] } {
  const unread: string[] = [];
  const sets: string[][] = [];
  const main = tokenAnswers(tokenize(item.jp));
  sets.push(main && main[0] === normalizeAnswer(fallback(item.jp)) ? main : [normalizeAnswer(fallback(item.jp)), ...(main ?? [])]);
  for (const alt of item.alternatives) {
    const read = tokenAnswers(tokenize(alt));
    if (read) sets.push(read.filter((a) => !NOT_KANA_RE.test(a)));
    else unread.push(alt);
  }
  const ordered = [...sets.flatMap((s) => s.slice(0, 1)), ...sets.flatMap((s) => s.slice(1))];
  return { answers: [...new Set(ordered)].filter(Boolean).slice(0, MAX_ANSWERS), unread };
}
