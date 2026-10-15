// The guess-first gloss of a study sentence: before the translation is shown, what does the target word mean?
// Three English options: the target's own gloss and two from other known words.

import { loadCoreWords, loadWordInfo } from '../../lib/data.ts';
import type { WordRef } from '../../lib/types.ts';
import { normalizeMeaning, shuffle } from '../../srs/answers.ts';
import type { KnownWords } from '../../srs/readListen.ts';

export const GLOSS_OPTIONS = 3;

export interface GlossQuestion {
  target: WordRef;
  /** The word as written in the sentence (underlined). */
  written: string;
  answer: string;
  options: string[];
}

/** The first sense of an English gloss: 'to eat; to live on' → 'to eat'. */
export function shortGloss(en: string): string {
  return en.split(/[;,(]/)[0].trim() || en.trim();
}

/** The target's gloss and two from other known core words (the same part of speech first), shuffled. */
export async function glossQuestion(target: WordRef, written: string, known: KnownWords, random: () => number = Math.random): Promise<GlossQuestion | null> {
  const [info, core] = await Promise.all([loadWordInfo(), loadCoreWords()]);
  const word = info(target);
  if (!word) return null;
  const answer = shortGloss(word.en);
  const own = normalizeMeaning(answer);
  const pos = word.core?.pos;
  const pool = core.filter((c) => `core:${c.id}` !== target && normalizeMeaning(shortGloss(c.en)) !== own);
  const knownPool = pool.filter((c) => known.isKnown(`core:${c.id}`));
  const tiers = [knownPool.filter((c) => c.pos === pos), knownPool, pool.filter((c) => c.pos === pos), pool];
  const picked: string[] = [];
  const seen = new Set([own]);
  for (const tier of tiers) {
    for (const c of shuffle(tier, random)) {
      if (picked.length >= GLOSS_OPTIONS - 1) break;
      const gloss = shortGloss(c.en);
      const key = normalizeMeaning(gloss);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(gloss);
    }
  }
  return { target, written, answer, options: shuffle([answer, ...picked], random) };
}
