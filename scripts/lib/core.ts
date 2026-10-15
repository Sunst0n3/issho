// Core words (content/core-words.json): validation, the build-time fields (kanji, unit, altKana),
// the id lock that freezes core ids at release, and the day-14 "Kana check" words.

import { isKanji } from '../../src/lib/ruby.ts';
import type { CorePos, CoreWord, KanaRule, Register, UnitSpec } from '../../src/lib/types.ts';
import { Checker, eachObject, labelOf, type ContentField, type ContentItem } from './checker.ts';

export const CORE_POS: readonly CorePos[] = [
  'noun', 'verb-ru', 'verb-u', 'verb-irr', 'adj-i', 'adj-na', 'adverb', 'particle-phrase', 'expression',
  'pronoun', 'demonstrative', 'counter', 'number', 'conjunction', 'interjection', 'suffix', 'prefix',
];

export const CORE_TOPICS: readonly string[] = [
  'conversation', 'greetings', 'people', 'family', 'home', 'food', 'drink', 'shopping', 'money', 'time',
  'calendar', 'numbers', 'places', 'transport', 'travel', 'weather', 'body', 'health', 'feelings', 'work',
  'school', 'hobbies', 'nature', 'animals', 'clothes', 'colors', 'actions', 'describing', 'questions', 'function',
];

export const REGISTERS: readonly Register[] = ['polite', 'plain', 'both'];

/** Longest English gloss: it has to fit a recall card. */
export const MAX_CORE_EN = 40;
/** Longest usage note. */
export const MAX_CORE_NOTE = 80;

/** The ids of v1's content/survival-words.json; each must live on as some core word's `survival`. */
export const V1_SURVIVAL_IDS: readonly string[] = [
  'sw-konnichiwa', 'sw-arigatou', 'sw-arigatougozaimasu', 'sw-sumimasen', 'sw-hai', 'sw-iie', 'sw-ohayou',
  'sw-ohayougozaimasu', 'sw-konbanwa', 'sw-oyasumi', 'sw-oyasuminasai', 'sw-sayounara', 'sw-jaane',
  'sw-gomennasai', 'sw-daijoubu', 'sw-kudasai', 'sw-onegaishimasu', 'sw-douzo', 'sw-hajimemashite',
  'sw-yoroshikuonegaishimasu', 'sw-wakarimasen', 'sw-wakarimashita', 'sw-mouichido', 'sw-yukkuri',
  'sw-itadakimasu', 'sw-gochisousamadeshita', 'sw-ittekimasu', 'sw-itterasshai', 'sw-tadaima',
  'sw-okaerinasai', 'sw-un', 'sw-uun', 'sw-soudesuka', 'sw-ii', 'sw-chotto', 'sw-genki', 'sw-watashi',
  'sw-anata', 'sw-namae', 'sw-nani', 'sw-doko', 'sw-itsu', 'sw-dare', 'sw-ikura', 'sw-nanji', 'sw-kore',
  'sw-sore', 'sw-are', 'sw-koko', 'sw-toire', 'sw-ichi', 'sw-ni', 'sw-san', 'sw-yon', 'sw-go', 'sw-roku',
  'sw-nana', 'sw-hachi', 'sw-kyuu', 'sw-juu', 'sw-hitotsu', 'sw-futatsu', 'sw-hitori', 'sw-futari', 'sw-en',
  'sw-mizu', 'sw-ocha', 'sw-koohii', 'sw-gohan', 'sw-pan', 'sw-oishii', 'sw-tamago', 'sw-niku', 'sw-sakana',
  'sw-yasai', 'sw-kudamono', 'sw-ringo', 'sw-mikan', 'sw-banana', 'sw-gyuunyuu', 'sw-biiru', 'sw-kanpai',
  'sw-kazoku', 'sw-otto', 'sw-tsuma', 'sw-haha', 'sw-chichi', 'sw-okaasan', 'sw-otousan', 'sw-kodomo',
  'sw-tomodachi', 'sw-suki', 'sw-daisuki', 'sw-aishiteru', 'sw-kawaii', 'sw-sugoi', 'sw-tanoshii',
  'sw-takai', 'sw-yasui', 'sw-ookii', 'sw-chiisai', 'sw-samui', 'sw-atsui', 'sw-tsukareta',
  'sw-otsukaresama', 'sw-kyou', 'sw-ashita', 'sw-kinou', 'sw-ima', 'sw-uchi', 'sw-eki', 'sw-nihongo',
  'sw-eigo', 'sw-hontou', 'sw-omedetou', 'sw-ganbatte', 'sw-terebi',
];

/** A core word as authored: CoreWord without the build-time fields. */
export type AuthoredCoreWord = Omit<CoreWord, 'kanji' | 'unit' | 'altKana'>;

const KANA_RE = /^[ぁ-ゖァ-ヺー]+$/u;
const KATAKANA_RE = /^[ァ-ヺー]+$/u;
const JMDICT_ID_RE = /^\d+$/;
const fold = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

/**
 * Structural checks for core words (one file, or one part file): unique ids, kana-only `kana`, a
 * `written` form that is any spelling (漢字, or Tシャツ), `en` ≤ 40 characters, the
 * pos/register/topic enums, a boolean `use`. Checks across all the words are in checkCoreWordSet.
 */
export function checkCoreWords(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'core words', (w, i) => {
    const id = c.id(w, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    const order = c.number(w, 'order', where);
    if (order !== undefined && (!Number.isInteger(order) || order < 1)) c.error(where, `"order" ${order} must be a whole number from 1`);
    const kana = c.string(w, 'kana', where);
    if (kana !== undefined) {
      if (!KANA_RE.test(kana)) c.error(where, `"kana" must be kana only, got "${kana}"`);
      fields.push({ path: `${where}.kana`, text: kana, ruby: false });
    }
    const written = c.string(w, 'written', where, true);
    if (written !== undefined) {
      if (/[{}|]/.test(written)) c.error(where, `"written" must be plain text, got "${written}"`);
      fields.push({ path: `${where}.written`, text: written, ruby: false });
    }
    const jmdict = c.string(w, 'jmdict', where, true);
    if (jmdict !== undefined && !JMDICT_ID_RE.test(jmdict)) c.error(where, `"jmdict" must be a JMdict ent_seq, got "${jmdict}"`);
    const en = c.string(w, 'en', where);
    if (en !== undefined && en.length > MAX_CORE_EN) c.error(where, `"en" is ${en.length} characters (at most ${MAX_CORE_EN})`);
    c.oneOf(w, 'pos', where, CORE_POS);
    c.oneOf(w, 'register', where, REGISTERS);
    c.oneOf(w, 'topic', where, CORE_TOPICS);
    c.boolean(w, 'use', where);
    const note = c.string(w, 'note', where, true);
    if (note !== undefined && note.length > MAX_CORE_NOTE) c.warn(where, `"note" is ${note.length} characters (${MAX_CORE_NOTE} expected)`);
    c.string(w, 'survival', where, true);
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

/**
 * Checks across all core words (merged from their files): `order` runs 1..N without gaps or
 * repeats, and every `survival` id is unique. A v1 survival id no core word carries is a warning.
 */
export function checkCoreWordSet(words: readonly unknown[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const orders = new Map<number, string>();
  const survival = new Map<string, string>();
  for (const w of words) {
    if (typeof w !== 'object' || w === null) continue;
    const { id, order, survival: sw } = w as { id?: unknown; order?: unknown; survival?: unknown };
    const name = String(id);
    if (typeof order === 'number' && Number.isInteger(order) && order >= 1) {
      if (orders.has(order)) errors.push(`${name}: "order" ${order} is also used by ${orders.get(order)}`);
      else orders.set(order, name);
    }
    if (typeof sw === 'string') {
      if (survival.has(sw)) errors.push(`${name}: survival id "${sw}" is also used by ${survival.get(sw)}`);
      else survival.set(sw, name);
    }
  }
  if (orders.size > 0) {
    const gaps: number[] = [];
    for (let n = 1; n <= Math.max(...orders.keys()); n++) if (!orders.has(n)) gaps.push(n);
    if (gaps.length > 0) errors.push(`"order" must run 1..N without gaps; missing ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? ', …' : ''}`);
  }
  if (words.length > 0) {
    const missing = V1_SURVIVAL_IDS.filter((sw) => !survival.has(sw));
    if (missing.length > 0) warnings.push(`${missing.length} v1 survival word(s) have no core word: ${missing.join(', ')}`);
  }
  return { errors, warnings };
}

/** Distinct kanji of a written form, in order. */
export function kanjiOf(written: string | undefined): string[] {
  return written ? [...new Set([...written].filter(isKanji))] : [];
}

/** The first unit whose coreWordCeiling covers `order`; the last unit when beyond every ceiling (1 without units). */
export function coreUnit(order: number, units: readonly Pick<UnitSpec, 'id' | 'coreWordCeiling'>[]): number {
  const sorted = [...units].sort((a, b) => a.id - b.id);
  return sorted.find((u) => u.coreWordCeiling >= order)?.id ?? sorted[sorted.length - 1]?.id ?? 1;
}

/** CoreWord with its build-time fields, in the published key order. */
export function deriveCoreWord(
  w: AuthoredCoreWord,
  units: readonly Pick<UnitSpec, 'id' | 'coreWordCeiling'>[],
  altKana: readonly string[] = [],
): CoreWord {
  const out: CoreWord = { id: w.id, order: w.order, kana: w.kana } as CoreWord;
  if (w.written !== undefined) out.written = w.written;
  if (w.jmdict !== undefined) out.jmdict = w.jmdict;
  out.en = w.en;
  out.pos = w.pos;
  out.register = w.register;
  out.topic = w.topic;
  out.use = w.use;
  if (w.note !== undefined) out.note = w.note;
  if (w.survival !== undefined) out.survival = w.survival;
  out.kanji = kanjiOf(w.written);
  out.unit = coreUnit(w.order, units);
  const alt = [...new Set(altKana)].filter((k) => k !== w.kana);
  if (alt.length > 0) out.altKana = alt;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Id lock (scripts/data/core-ids.lock.json): from release on, a core id is a durable key on each
// phone (items, cards, pitch boxes, staged rows, partner-quiz keys), so its meaning may not change.

export type CoreIdLock = Record<string, { kana: string; written?: string }>;

export function makeCoreIdLock(words: readonly Pick<CoreWord, 'id' | 'kana' | 'written'>[]): CoreIdLock {
  const lock: CoreIdLock = {};
  for (const w of [...words].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    lock[w.id] = w.written === undefined ? { kana: w.kana } : { kana: w.kana, written: w.written };
  }
  return lock;
}

/** Errors for every locked id that is gone or now means another word (kana and written compared hiragana-folded). */
export function checkCoreIdLock(lock: CoreIdLock, words: readonly Pick<CoreWord, 'id' | 'kana' | 'written'>[]): string[] {
  const byId = new Map(words.map((w) => [w.id, w]));
  const errors: string[] = [];
  for (const [id, locked] of Object.entries(lock)) {
    const w = byId.get(id);
    const was = `${locked.written ?? ''}${locked.written ? ' ' : ''}${locked.kana}`;
    if (!w) {
      errors.push(`core id ${id} (${was}) is locked but no longer exists`);
      continue;
    }
    if (fold(w.kana) !== fold(locked.kana) || fold(w.written ?? '') !== fold(locked.written ?? '')) {
      errors.push(`core id ${id} is locked as ${was} but is now ${w.written ?? ''}${w.written ? ' ' : ''}${w.kana}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------

export const KANA_CHECK_SIZE = 10;
const MENU_TOPICS = new Set(['food', 'drink']);

/**
 * The day-14 "Kana check": core words read in katakana, food and drink first (a menu), lowest
 * `order` first, topped up from other katakana core words when there are fewer than `size`.
 */
export function kanaCheckWords(core: readonly CoreWord[], size = KANA_CHECK_SIZE): NonNullable<KanaRule['checkWords']> {
  const katakana = [...core].filter((w) => KATAKANA_RE.test(w.kana)).sort((a, b) => a.order - b.order);
  const menu = katakana.filter((w) => MENU_TOPICS.has(w.topic));
  const rest = katakana.filter((w) => !MENU_TOPICS.has(w.topic));
  return [...menu, ...rest].slice(0, size).map((w) => ({ kana: w.kana, en: w.en, ref: `core:${w.id}` as const }));
}
