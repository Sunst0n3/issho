// Pre-tokenised words for the app (PreToken), from the build-time tokenizer's tokens, with every
// JMdict ref that is also a core word rewritten to its single identity `core:<id>`.

import type { PreToken, WordRef } from '../../src/lib/types.ts';
import type { RubyToken } from '../v2/tokenize.ts';
import { canonicalRef } from './identity.ts';

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/u;
const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));
const KIND: Record<RubyToken['kind'], PreToken['k']> = { content: 'c', function: 'f', punct: 'p' };

export interface PreTokenOptions {
  /** Stories: number each token's phrase (`ph`). */
  phrases?: boolean;
  /**
   * The written form of a words.json entry. A name keeps a JMdict ref only when it is that entry's
   * spelling (東京); a name matched by its kana alone (エマ → 絵馬) gets none.
   */
  writtenOf?: (id: string) => string | undefined;
}

/** PreTokens in the published key order (s, r, ref, k, name, ph). */
export function toPreTokens(
  tokens: readonly RubyToken[],
  links: ReadonlyMap<string, string>,
  options: PreTokenOptions = {},
): PreToken[] {
  return tokens.map((t) => {
    const out: PreToken = { s: t.surface } as PreToken;
    if (KANJI_RE.test(t.surface) && t.reading) out.r = toHiragana(t.reading);
    const nameByKana = t.proper && t.ref?.startsWith('word:') && options.writtenOf?.(t.ref.slice(5)) !== t.surface;
    if (t.ref && !nameByKana) out.ref = canonicalRef(t.ref, links) as WordRef;
    out.k = KIND[t.kind];
    if (t.proper) out.name = true;
    if (options.phrases) out.ph = t.phrase;
    return out;
  });
}

/** Distinct refs of the content words, names left out, in order of appearance. */
export function contentRefs(tokens: readonly PreToken[]): WordRef[] {
  const out = new Set<WordRef>();
  for (const t of tokens) if (t.k === 'c' && t.ref && !t.name) out.add(t.ref);
  return [...out];
}

export interface RefCoverage {
  /** Content tokens, names left out. */
  content: number;
  /** Of those, core words with order ≤ the ceiling. */
  covered: number;
  ratio: number;
  /** Content tokens with no ref at all (neither a core word nor a JMdict word). */
  unknown: string[];
}

/** Share of content tokens (names left out) that are core words with order ≤ `ceiling`. */
export function refCoverage(tokens: readonly PreToken[], coreOrder: ReadonlyMap<string, number>, ceiling: number): RefCoverage {
  let content = 0;
  let covered = 0;
  const unknown: string[] = [];
  for (const t of tokens) {
    if (t.k !== 'c' || t.name) continue;
    content++;
    if (!t.ref) unknown.push(t.s);
    else if (t.ref.startsWith('core:') && (coreOrder.get(t.ref.slice(5)) ?? Infinity) <= ceiling) covered++;
  }
  return { content, covered, ratio: content ? covered / content : 1, unknown };
}
