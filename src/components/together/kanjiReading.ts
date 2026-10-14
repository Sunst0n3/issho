// Which reading of a kanji goes with a given meaning, for prompts that show both.

import type { KanjiEntry, WordEntry } from '../../lib/types.ts';

const gloss = (meaning: string) => meaning.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();

/**
 * The reading to show beside a kanji's first meaning (the quiz's "write it from
 * memory" prompt). It must be one used in that sense: 本 "book" is ほん (もと means
 * origin), 月 "month" is がつ (つき is the moon). That's the reading of a word written
 * as the kanji alone with that meaning; failing one, the on reading, the one used in
 * compounds.
 */
export function readingFor(entry: KanjiEntry, words: readonly WordEntry[]): string {
  const meaning = gloss(entry.meanings[0] ?? '');
  const word = words
    .filter((w) => w.written === entry.char && w.meanings.some((m) => gloss(m) === meaning))
    .sort((a, b) => a.freqRank - b.freqRank)[0];
  return word?.kana ?? entry.on[0] ?? entry.kun[0]?.replace(/[.-]/g, '') ?? '';
}
