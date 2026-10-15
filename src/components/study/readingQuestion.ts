// The guess-first gloss of a study sentence: before the translation is shown, what does the target word mean?
// Three English options: the target's own gloss and two from other known words, none sharing a sense with it.

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

/**
 * The first sense of an English gloss with its qualifier, the ~ placeholder dropped: 'to eat; to live on' → 'to eat',
 * 'that ~ (over there)' → 'that (over there)', 'this (one, near me)' stays whole (a comma in brackets is no break).
 */
export function shortGloss(en: string): string {
  let depth = 0;
  let cut = en.length;
  for (let i = 0; i < en.length && cut === en.length; i++) {
    const c = en[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if ((c === ';' || c === ',') && depth === 0) cut = i;
  }
  const first = en.slice(0, cut).replace(/[~〜]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([?!.,)])/g, '$1').trim();
  return first || en.trim();
}

/** Every sense a gloss names, bracketed ones included: 'that ~ (over there)' → ['that', 'over there']. */
function senses(en: string): string[] {
  return en.split(/[;,()]/).map(normalizeMeaning).filter(Boolean);
}

/**
 * The target's gloss and two from other known core words (the same part of speech first), shuffled. A word that
 * shares any sense with the target is never a wrong option: あそこ 'over there' is what あの 'that ~ (over there)' means.
 */
export async function glossQuestion(target: WordRef, written: string, known: KnownWords, random: () => number = Math.random): Promise<GlossQuestion | null> {
  const [info, core] = await Promise.all([loadWordInfo(), loadCoreWords()]);
  const word = info(target);
  if (!word) return null;
  const answer = shortGloss(word.en);
  const own = normalizeMeaning(answer);
  const ownSenses = new Set([own, ...senses(word.en)]);
  const pos = word.core?.pos;
  const pool = core.filter((c) => `core:${c.id}` !== target);
  const knownPool = pool.filter((c) => known.isKnown(`core:${c.id}`));
  const tiers = [knownPool.filter((c) => c.pos === pos), knownPool, pool.filter((c) => c.pos === pos), pool];
  const picked: string[] = [];
  // The wrong options don't share a sense with each other either.
  const seen = new Set(ownSenses);
  for (const tier of tiers) {
    for (const c of shuffle(tier, random)) {
      if (picked.length >= GLOSS_OPTIONS - 1) break;
      const gloss = shortGloss(c.en);
      const its = [normalizeMeaning(gloss), ...senses(c.en)];
      if (its.some((x) => seen.has(x))) continue;
      for (const x of its) seen.add(x);
      picked.push(gloss);
    }
  }
  return { target, written, answer, options: shuffle([answer, ...picked], random) };
}
