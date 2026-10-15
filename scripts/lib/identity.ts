// Word identity: a word that is both a JMdict entry (words.json) and a core word is one item,
// `core:<id>`, everywhere (curriculum anchors and staged words, sentence and story tokens,
// targets, accent and audio refs). See TECH-DESIGN §3.6.3.

import type { WordRef } from '../../src/lib/types.ts';

/** The fields of a core word that decide its identity. */
export interface IdentityCore {
  id: string;
  order: number;
  kana: string;
  written?: string;
  jmdict?: string;
}

/** The fields of a words.json entry that decide its identity. */
export interface IdentityEntry {
  id: string;
  written: string;
  kana: string;
  kanji: readonly string[];
}

const fold = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

/**
 * How strongly a core word and an entry were matched; the lower rank wins when several core words
 * match one entry. SPELLING: same spelling and reading. ID: `jmdict` names the entry, but the core
 * word may be another of its spellings or readings (十 とお for 十 じゅう). USUAL_KANJI: a kana-only
 * core word and the entry that is its usual kanji spelling.
 */
const SPELLING = 0;
const ID = 1;
const USUAL_KANJI = 2;

/**
 * Links words.json entries to the core words they are, as JMdict id → core id. An entry and a core
 * word `c` are the same word when
 * - `c.jmdict` is the entry's id, or
 * - `c.written` and `c.kana` equal the entry's spelling and reading (hiragana-folded), or
 * - `c` is kana-only, reads as the entry, and the entry is that kana word's usual kanji spelling
 *   (`usualKanji(c.kana)`: the JMdict entry whose reading list starts with it).
 * When several core words name one entry (早い and 速い are both JMdict 1404975), the entry goes to
 * the one spelled and read like it, else the lowest `order`; the others stay core-only words.
 */
export function linkCoreWords(
  core: readonly IdentityCore[],
  entries: readonly IdentityEntry[],
  usualKanji: (kana: string) => string | undefined = () => undefined,
): Map<string, string> {
  const byId = new Map<string, IdentityCore[]>();
  const bySpelling = new Map<string, IdentityCore[]>();
  const kanaOnly = new Map<string, IdentityCore[]>();
  const add = (map: Map<string, IdentityCore[]>, key: string, c: IdentityCore) => {
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  };
  for (const c of core) {
    if (c.jmdict) add(byId, c.jmdict, c);
    if (c.written) add(bySpelling, `${c.written}|${fold(c.kana)}`, c);
    else add(kanaOnly, fold(c.kana), c);
  }

  const links = new Map<string, string>();
  for (const e of entries) {
    const matches: [number, IdentityCore][] = [];
    for (const c of bySpelling.get(`${e.written}|${fold(e.kana)}`) ?? []) matches.push([SPELLING, c]);
    for (const c of byId.get(e.id) ?? []) matches.push([ID, c]);
    if (e.kanji.length > 0) {
      for (const c of kanaOnly.get(fold(e.kana)) ?? []) {
        if (c.jmdict === undefined && usualKanji(c.kana) === e.id) matches.push([USUAL_KANJI, c]);
      }
    }
    if (matches.length === 0) continue;
    matches.sort(([ma, a], [mb, b]) => ma - mb || a.order - b.order);
    links.set(e.id, matches[0][1].id);
  }
  return links;
}

/** The item ref of a words.json entry: `core:<id>` when it is a core word, else `word:<id>`. */
export function wordRef(id: string, links: ReadonlyMap<string, string>): WordRef {
  const core = links.get(id);
  return core ? `core:${core}` : `word:${id}`;
}

/** Rewrites a `word:<id>` ref to `core:<id>` when the entry is a core word; other refs are kept. */
export function canonicalRef<T extends string>(ref: T, links: ReadonlyMap<string, string>): T | WordRef {
  if (!ref.startsWith('word:')) return ref;
  return wordRef(ref.slice(5), links);
}
