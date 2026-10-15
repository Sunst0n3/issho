// Memory hooks: kanji mnemonics (content/mnemonics.json, published as MnemonicsFile) and the kana
// picture hooks (content/kana-examples.json `hook`). The lint is a warning in the build and a test
// in content-mnemonics.test.ts (TECH-DESIGN §3.6.1 step 11).

import type { CurriculumUnit, KanjiEntry, MnemonicEntry, MnemonicsFile, RadicalEntry } from '../../src/lib/types.ts';
import { Checker, isObj, type ContentItem } from './checker.ts';

/** Kanji of curriculum rank ≤ this need a meaning hook and a sound hook. */
export const HOOKED_RANK = 500;
export const MAX_HOOK_WORDS = 20;
export const MAX_KANA_HOOK_WORDS = 12;

/** content/mnemonics.json: { "日": "…" } (v1) or { "日": { "meaning": "…", "sound": "…" } }. */
export function checkMnemonics(data: unknown, c: Checker): ContentItem[] {
  if (!isObj(data)) {
    c.error('file', 'must be an object mapping a character to its memory hook');
    return [];
  }
  const items: ContentItem[] = [];
  for (const [char, hook] of Object.entries(data)) {
    const where = `"${char}"`;
    if ([...char].length !== 1) c.error(where, 'keys must be a single character');
    if (typeof hook === 'string') {
      if (!hook.trim()) c.error(where, 'memory hook must be a non-empty string');
    } else if (isObj(hook)) {
      c.string(hook, 'meaning', where);
      c.string(hook, 'sound', where, true);
    } else {
      c.error(where, 'memory hook must be a string or { "meaning", "sound"? }');
    }
    items.push({ id: char, where, fields: [], chars: [char] });
  }
  return items;
}

/** Every value as { meaning, sound? } (v1 strings become the meaning hook). */
export function normalizeMnemonics(data: Readonly<Record<string, unknown>>): MnemonicsFile {
  const out: MnemonicsFile = {};
  for (const [char, hook] of Object.entries(data)) {
    if (typeof hook === 'string') out[char] = { meaning: hook.trim() };
    else if (isObj(hook) && typeof hook.meaning === 'string') {
      const entry: MnemonicEntry = { meaning: hook.meaning.trim() };
      if (typeof hook.sound === 'string' && hook.sound.trim()) entry.sound = hook.sound.trim();
      out[char] = entry;
    }
  }
  return out;
}

/** Words of an English hook (anything with a letter or digit between spaces). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const CLOSERS_RE = /["'”’)\]]+$/u;

/** Exactly one sentence: one terminal . ! or ? (before any closing quote) and none inside. */
export function isOneSentence(text: string): boolean {
  const body = text.trim().replace(CLOSERS_RE, '');
  if (!/[.!?]$/.test(body)) return false;
  const inside = body.slice(0, -1).replace(/\.\.\.|…/g, '');
  return !/[.!?](\s|$)/.test(inside);
}

export interface HookContext {
  /** Curriculum rank (1-based) of each kanji. */
  rank: ReadonlyMap<string, number>;
  /** Components and named parts of each kanji. */
  partsOf: (char: string) => readonly string[];
  /** The kanji's own meanings (KANJIDIC2), which a hook may always say: 西 "west", 宮 "shrine". */
  meaningsOf?: (char: string) => readonly string[];
  /**
   * Part names a hook may mention, lower-cased → the characters that carry the name (named parts
   * by their name, component kanji by their keyword). Plain-English words never count (PLAIN_ENGLISH).
   */
  partNames: ReadonlyMap<string, readonly string[]>;
}

/**
 * Everyday English words that are also kanji keywords ("one", "inside", "small", "time"): a hook
 * uses them as plain English, so they never count as naming a part.
 */
export const PLAIN_ENGLISH = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'by', 'for', 'with', 'from', 'up', 'down', 'out', 'off',
  'over', 'under', 'inside', 'outside', 'below', 'above', 'before', 'after', 'between', 'among', 'beside',
  'behind', 'front', 'back', 'left', 'right', 'top', 'bottom', 'middle', 'center', 'centre', 'side', 'end',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand',
  'all', 'each', 'every', 'some', 'any', 'many', 'much', 'more', 'most', 'few', 'little', 'small', 'big',
  'large', 'long', 'short', 'wide', 'tall', 'high', 'low', 'good', 'bad', 'new', 'old', 'whole', 'half',
  'same', 'other', 'even', 'again', 'together', 'also', 'very', 'can', 'do', 'be', 'have', 'go', 'going',
  'come', 'say', 'see', 'look', 'time', 'someone', 'something', 'thing', 'things', 'part', 'not', 'no',
  'yes', 'this', 'that', 'here', 'there', 'now', 'then', 'only', 'just', 'like', 'round', 'upright', 'open',
  'close', 'shut', 'full', 'empty', 'straight', 'first', 'last', 'next', 'name', 'way', 'use', 'make',
]);

/** A name as the lint matches it: lower case, without a trailing "(…)". */
const nameKey = (name: string) => name.toLowerCase().replace(/\s*\(.*\)$/, '').trim();

/**
 * The lint context from the built data: curriculum ranks, each kanji's components and named parts,
 * and the part names a hook may mention (component kanji by keyword, named parts by name).
 */
export function hookContext(
  units: readonly Pick<CurriculumUnit, 'char' | 'index'>[],
  kanji: Readonly<Record<string, Pick<KanjiEntry, 'meanings' | 'components' | 'parts'>>>,
  namedParts: readonly Pick<RadicalEntry, 'char' | 'name'>[],
): HookContext {
  const partNames = new Map<string, string[]>();
  const add = (name: string, ch: string) => {
    const key = nameKey(name);
    if (!key) return;
    const list = partNames.get(key) ?? [];
    if (!list.includes(ch)) list.push(ch);
    partNames.set(key, list);
  };
  const components = new Set(Object.values(kanji).flatMap((k) => k.components));
  for (const ch of components) if (kanji[ch]) add(kanji[ch].meanings[0], ch);
  for (const p of namedParts) add(p.name, p.char);
  return {
    rank: new Map(units.map((u) => [u.char, u.index + 1])),
    partsOf: (ch) => [...(kanji[ch]?.components ?? []), ...(kanji[ch]?.parts ?? [])],
    meaningsOf: (ch) => kanji[ch]?.meanings ?? [],
    partNames,
  };
}

/** Words of a text, lower-cased, for matching part names (one or two words long). */
function phrases(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+(?:[-'][a-z]+)*/g) ?? [];
  const out = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * Problems with the kanji hooks: a kanji of rank ≤ 500 without a meaning or sound hook; a meaning
 * hook that is not exactly one sentence of ≤ 20 words; a part name that is neither the kanji
 * itself nor one of its components or named parts. The kanji's own meanings are always allowed
 * (西 may say "west"), and so is a single word inside one of its own two-word names ("rice" in
 * 田's "rice field").
 */
export function lintMnemonics(file: MnemonicsFile, ctx: HookContext, maxRank = HOOKED_RANK): string[] {
  const problems: string[] = [];
  const hooked = [...ctx.rank].filter(([, r]) => r <= maxRank).sort((a, b) => a[1] - b[1]);
  const noMeaning = hooked.filter(([ch]) => !file[ch]?.meaning).map(([ch]) => ch);
  if (noMeaning.length > 0) problems.push(`${noMeaning.length} kanji of rank ≤ ${maxRank} have no meaning hook: ${noMeaning.join('')}`);
  const noSound = hooked.filter(([ch]) => !file[ch]?.sound).map(([ch]) => ch);
  if (noSound.length > 0) problems.push(`${noSound.length} kanji of rank ≤ ${maxRank} have no sound hook: ${noSound.join('')}`);

  for (const [char, { meaning }] of Object.entries(file)) {
    if (!isOneSentence(meaning)) problems.push(`${char}: the meaning hook must be exactly one sentence: "${meaning}"`);
    const words = wordCount(meaning);
    if (words > MAX_HOOK_WORDS) problems.push(`${char}: the meaning hook has ${words} words (at most ${MAX_HOOK_WORDS})`);
    const own = new Set([char, ...ctx.partsOf(char)]);
    const ownNames = new Set((ctx.meaningsOf?.(char) ?? []).map(nameKey));
    for (const [name, carriers] of ctx.partNames) if (carriers.some((p) => own.has(p))) ownNames.add(name);
    const found = phrases(meaning);
    // Words of an own two-word name that the hook spells out in full.
    const inOwnName = new Set([...found].filter((p) => p.includes(' ') && ownNames.has(p)).flatMap((p) => p.split(' ')));
    for (const phrase of found) {
      if (PLAIN_ENGLISH.has(phrase) || ownNames.has(phrase) || inOwnName.has(phrase)) continue;
      const carriers = ctx.partNames.get(phrase);
      if (!carriers || carriers.some((p) => own.has(p))) continue;
      problems.push(`${char}: the meaning hook names "${phrase}" (${carriers.join('')}), which is not one of its parts`);
    }
  }
  return problems;
}

/** Problems with the kana picture hooks: a basic kana without one, more than one line, or over 12 words. */
export function lintKanaHooks(examples: Readonly<Record<string, { hook?: string }>>, basicKana: readonly string[]): string[] {
  const problems: string[] = [];
  const missing = basicKana.filter((k) => !examples[k]?.hook?.trim());
  if (missing.length > 0) problems.push(`${missing.length} basic kana have no picture hook: ${missing.join('')}`);
  for (const [kana, { hook }] of Object.entries(examples)) {
    if (hook === undefined) continue;
    if (/\n/.test(hook)) problems.push(`${kana}: the hook must be one line`);
    const words = wordCount(hook);
    if (words > MAX_KANA_HOOK_WORDS) problems.push(`${kana}: the hook has ${words} words (at most ${MAX_KANA_HOOK_WORDS})`);
  }
  return problems;
}
