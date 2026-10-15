// Validation and loading for the hand-authored files in content/ (core words, grammar, units,
// stories, role-plays, sentences, mnemonics, kana examples and rules, confusable sets). Used by
// build-data, check-content and the content tests.
//
// Each kind is read from a folder of JSON files or a single file (readContentSources); every file
// holds one entry or an array. Structural errors (bad JSON, missing fields, duplicate ids, broken
// ruby) fail the build; content that is still being written only warns.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isKanaOnly, isKanji, kanjiIn, parseRuby, rubyToPlain } from '../../src/lib/ruby.ts';
import type { CurriculumUnit, KanaEntry, KanaRuleId } from '../../src/lib/types.ts';
import {
  Checker,
  canonicalJson,
  eachObject,
  isObj,
  labelOf,
  type ContentField,
  type ContentItem,
  type ContentReport,
  type Obj,
} from './checker.ts';
import { checkCoreWords, checkCoreWordSet, REGISTERS } from './core.ts';
import { buildKanaTable } from './kana.ts';
import { checkMnemonics } from './mnemonics.ts';
import { isCounterReading, toHiragana } from './readings.ts';
import { checkRolePlays } from './roleplays.ts';
import { checkStories } from './stories.ts';
import { checkUnits } from './units.ts';

export { Checker, type ContentField, type ContentItem, type ContentReport } from './checker.ts';

export type ContentKind =
  | 'core-words'
  | 'grammar'
  | 'units'
  | 'stories'
  | 'roleplays'
  | 'sentences'
  | 'mnemonics'
  | 'kana-examples'
  | 'kana-rules'
  | 'confusables';

export const CONTENT_KINDS: readonly ContentKind[] = [
  'core-words',
  'grammar',
  'units',
  'stories',
  'roleplays',
  'sentences',
  'mnemonics',
  'kana-examples',
  'kana-rules',
  'confusables',
];

/** Kinds authored as one object keyed by character instead of an array of entries. */
const KEYED_KINDS: readonly ContentKind[] = ['mnemonics', 'kana-examples'];

/** The published file name of each kind, under public/data/content/ (confusables go into curriculum.json). */
export function contentFileName(kind: ContentKind): string {
  return `${kind}.json`;
}

/** What an absent content file is replaced with. */
export function emptyContent(kind: ContentKind): unknown[] | Record<string, never> {
  return KEYED_KINDS.includes(kind) ? {} : [];
}

/** The blank in a grammar drill prompt. */
export const DRILL_BLANK = '＿＿';

export const GRAMMAR_LEVELS = ['N5', 'N4'] as const;
export const MIN_GRAMMAR_POINTS = 110;
export const MIN_GRAMMAR_EXAMPLES = 8;
export const MIN_BUILD_ITEMS = 4;
export const MIN_DRILLS = 4;
export const BUILD_TILES = { min: 3, max: 7 } as const;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * grammar-v2: per point, ≥ 8 examples, ≥ 4 build items unless recognitionOnly (whose tiles join to
 * exactly the plain text of `jp`), ≥ 4 drills with one blank. Cross-point checks (prerequisites,
 * contrasts, the point count) are in checkGrammarSet.
 */
function checkGrammar(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'grammar points', (g, i) => {
    const id = c.id(g, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    if (id !== undefined && !KEBAB_RE.test(id)) c.error(where, 'id must be kebab-case');
    const order = c.number(g, 'order', where);
    if (order !== undefined && (!Number.isInteger(order) || order < 1)) c.error(where, '"order" must be a whole number from 1');
    c.oneOf(g, 'level', where, GRAMMAR_LEVELS);
    c.string(g, 'title', where);
    c.string(g, 'explanation', where);
    c.ruby(g, 'pattern', where, fields);
    c.oneOf(g, 'register', where, REGISTERS);
    const recognitionOnly = c.boolean(g, 'recognitionOnly', where, true) ?? false;
    c.strings(g, 'prerequisites', where);
    c.strings(g, 'contrastWith', where);

    const examples = c.array(g, 'examples', where);
    if (examples.length < MIN_GRAMMAR_EXAMPLES) c.error(where, `has ${examples.length} examples (at least ${MIN_GRAMMAR_EXAMPLES})`);
    examples.forEach((ex, j) => {
      const at = `${where}.examples[${j}]`;
      if (!isObj(ex)) return c.error(at, 'must be an object');
      c.ruby(ex, 'jp', at, fields);
      c.string(ex, 'en', at);
    });

    const builds = c.array(g, 'buildItems', where);
    if (!recognitionOnly && builds.length < MIN_BUILD_ITEMS) c.error(where, `has ${builds.length} build items (at least ${MIN_BUILD_ITEMS})`);
    if (recognitionOnly && builds.length > 0) c.warn(where, 'is recognitionOnly but has build items (they are never asked)');
    builds.forEach((b, j) => {
      const at = `${where}.buildItems[${j}]`;
      if (!isObj(b)) return c.error(at, 'must be an object');
      c.string(b, 'en', at);
      const jp = c.ruby(b, 'jp', at, fields);
      const tiles = c.strings(b, 'tiles', at);
      if (tiles.length < BUILD_TILES.min || tiles.length > BUILD_TILES.max) {
        c.warn(at, `has ${tiles.length} tiles (${BUILD_TILES.min}–${BUILD_TILES.max} expected)`);
      }
      if (jp !== undefined && tiles.join('') !== rubyToPlain(jp)) c.error(at, `tiles "${tiles.join('|')}" do not join to "${rubyToPlain(jp)}"`);
      const alternatives = c.array(b, 'alternatives', at);
      alternatives.forEach((alt, k) => {
        if (typeof alt !== 'string' || !alt.trim()) c.error(at, `alternative ${k} must be a non-empty string`);
        else if (/[{}|]/.test(alt)) c.error(at, `alternative "${alt}" must be plain text`);
      });
    });

    const drills = c.array(g, 'drills', where);
    if (drills.length < MIN_DRILLS) c.error(where, `has ${drills.length} drills (at least ${MIN_DRILLS})`);
    drills.forEach((d, j) => {
      const at = `${where}.drills[${j}]`;
      if (!isObj(d)) return c.error(at, 'must be an object');
      const prompt = c.ruby(d, 'prompt', at, fields);
      if (prompt !== undefined && prompt.split(DRILL_BLANK).length !== 2) c.error(at, `prompt must have one blank "${DRILL_BLANK}"`);
      c.string(d, 'en', at);
      const options = c.array(d, 'options', at);
      if (options.length < 2) c.error(at, 'needs at least 2 options');
      else if (options.length > 4) c.warn(at, `has ${options.length} options (3-4 expected)`);
      options.forEach((opt, k) => {
        if (typeof opt !== 'string' || !opt.trim()) c.error(at, `option ${k} must be a non-empty string`);
        else if (/[{}|]/.test(opt) || [...opt].some(isKanji)) c.error(at, `option "${opt}" must be plain kana`);
      });
      if (new Set(options).size !== options.length) c.error(at, 'options must be distinct');
      const answer = d.answer;
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        c.error(at, `"answer" ${JSON.stringify(answer)} is not an index into its ${options.length} options`);
      }
    });
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

/**
 * Checks across the grammar points: at least 110, `order` without repeats, prerequisites that
 * exist, come earlier by order and form no cycle, and contrastWith ids that exist.
 */
export function checkGrammarSet(points: readonly Obj[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (points.length < MIN_GRAMMAR_POINTS) errors.push(`grammar-v2 has ${points.length} points (at least ${MIN_GRAMMAR_POINTS})`);
  const order = new Map<string, number>();
  const seenOrder = new Map<number, string>();
  for (const p of points) {
    if (typeof p.id !== 'string' || typeof p.order !== 'number') continue;
    order.set(p.id, p.order);
    const other = seenOrder.get(p.order);
    if (other) errors.push(`${p.id}: order ${p.order} is also used by ${other}`);
    seenOrder.set(p.order, p.id);
  }
  const prereqs = new Map<string, string[]>();
  for (const p of points) {
    if (typeof p.id !== 'string') continue;
    const own = order.get(p.id) ?? 0;
    const list = Array.isArray(p.prerequisites) ? p.prerequisites.filter((x): x is string => typeof x === 'string') : [];
    prereqs.set(p.id, list);
    for (const q of list) {
      if (!order.has(q)) errors.push(`${p.id}: prerequisite "${q}" does not exist`);
      else if (order.get(q)! >= own) errors.push(`${p.id}: prerequisite "${q}" (#${order.get(q)}) does not come before it (#${own})`);
    }
    for (const q of Array.isArray(p.contrastWith) ? p.contrastWith : []) {
      if (typeof q === 'string' && !order.has(q)) errors.push(`${p.id}: contrastWith "${q}" does not exist`);
    }
  }
  // Cycles (only possible together with an order error above, but reported on their own).
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      errors.push(`prerequisite cycle: ${[...path.slice(path.indexOf(id)), id].join(' → ')}`);
      return;
    }
    state.set(id, 'open');
    for (const q of prereqs.get(id) ?? []) if (prereqs.has(q)) visit(q, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of prereqs.keys()) visit(id, []);
  return { errors, warnings };
}

/** Plan change 7: plain forms recognised by about course day 60, i.e. grammar order ≤ 22 at the governed pace. */
export const PLAIN_FORM_POINTS: readonly string[] = ['dictionary-form', 'casual-speech', 'nai-form', 'casual-past'];
export const PLAIN_FORM_MAX_ORDER = 22;

/**
 * The plain-form points taught later than plan change 7 wants (order > 22), in order. The build
 * reports them as an info line: the authors keep their order (lead decision).
 */
export function latePlainForms(points: readonly { id: string; order: number }[]): { id: string; order: number }[] {
  return points
    .filter((p) => PLAIN_FORM_POINTS.includes(p.id) && p.order > PLAIN_FORM_MAX_ORDER)
    .map(({ id, order }) => ({ id, order }))
    .sort((a, b) => a.order - b.order);
}

function checkSentences(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'sentences', (s, i) => {
    const id = c.id(s, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    c.ruby(s, 'jp', where, fields);
    c.string(s, 'en', where);
    for (const g of c.array(s, 'grammar', where, true)) {
      if (typeof g !== 'string') c.error(where, '"grammar" must list grammar point ids');
    }
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

/** The four kana-rule lessons and their sprint days. */
export const KANA_RULE_DAYS: Readonly<Record<KanaRuleId, number>> = {
  'hira-dakuten': 6,
  'hira-yoon': 7,
  'kata-dakuten-yoon': 13,
  'kata-extended': 14,
};
export const KANA_RULE_PRACTICE_WORDS = 8;
/** Always readable in a practice word: the small tsu and the long-vowel mark (taught with the rules). */
const ALWAYS_READABLE = new Set([...'っッー']);

/** The script of a kana rule: hiragana for hira-*, katakana for kata-*. */
export function kanaRuleScript(id: string): 'hiragana' | 'katakana' {
  return id.startsWith('kata-') ? 'katakana' : 'hiragana';
}

/**
 * Kana a learner can read on a sprint day, with no kana known before the sprint: basic kana by
 * their sprintDay, plus every character a rule taught by that day pairs to.
 */
export function kanaReadableBy(day: number, rules: readonly { day: number; pairs: { to: string }[] }[]): Set<string> {
  const out = new Set<string>(ALWAYS_READABLE);
  for (const k of kanaCourse().values()) if (k.sprintDay !== undefined && k.sprintDay <= day) out.add(k.char);
  for (const r of rules) {
    if (r.day > day) continue;
    for (const p of r.pairs) for (const ch of p.to) out.add(ch);
  }
  return out;
}

/** content/kana-rules.json: the four rule lessons, each with pairs and 8 practice words. */
function checkKanaRules(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  const rules: { id: string; day: number; pairs: { to: string }[]; words: string[]; where: string }[] = [];
  eachObject(data, c, 'kana rules', (r, i) => {
    const id = c.id(r, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    const known = id !== undefined && Object.hasOwn(KANA_RULE_DAYS, id);
    if (id !== undefined && !known) c.error(where, `id must be one of ${Object.keys(KANA_RULE_DAYS).join(', ')}`);
    const day = c.number(r, 'day', where);
    if (known && day !== undefined && day !== KANA_RULE_DAYS[id as KanaRuleId]) c.error(where, `"day" must be ${KANA_RULE_DAYS[id as KanaRuleId]}`);
    c.string(r, 'title', where);
    c.string(r, 'explanation', where);
    const pairs: { to: string }[] = [];
    c.array(r, 'pairs', where).forEach((p, j) => {
      const at = `${where}.pairs[${j}]`;
      if (!isObj(p)) return c.error(at, 'must be an object');
      const from = c.string(p, 'from', at);
      const to = c.string(p, 'to', at);
      c.string(p, 'romaji', at);
      for (const k of [from, to]) if (k !== undefined && !isKanaOnly(k)) c.error(at, `"${k}" must be kana`);
      if (to !== undefined) pairs.push({ to });
    });
    if (pairs.length === 0) c.error(where, 'has no pairs');
    const words: string[] = [];
    const practice = c.array(r, 'practiceWords', where);
    if (practice.length !== KANA_RULE_PRACTICE_WORDS) c.warn(where, `has ${practice.length} practice words (${KANA_RULE_PRACTICE_WORDS} expected)`);
    practice.forEach((w, j) => {
      const at = `${where}.practiceWords[${j}]`;
      if (!isObj(w)) return c.error(at, 'must be an object');
      const kana = c.string(w, 'kana', at);
      c.string(w, 'en', at);
      if (kana === undefined) return;
      if (!isKanaOnly(kana)) c.error(at, `"kana" must be kana only, got "${kana}"`);
      else {
        words.push(kana);
        fields.push({ path: `${at}.kana`, text: kana, ruby: false });
      }
    });
    if (id !== undefined && day !== undefined) rules.push({ id, day, pairs, words, where });
    items.push({ id: id ?? String(i), where, fields });
  });
  for (const r of rules) {
    const readable = kanaReadableBy(r.day, rules);
    for (const w of r.words) {
      const unknown = [...w].filter((ch) => !readable.has(ch));
      if (unknown.length > 0) c.warn(r.where, `practice word "${w}" uses ${unknown.join('')}, not taught by day ${r.day}`);
    }
  }
  return items;
}

/** content/confusables.json: ConfusableSet[] ({ id, chars, kind: 'visual' | 'meaning' }). */
function checkConfusables(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'confusable sets', (s, i) => {
    const id = c.id(s, `[${i}]`);
    const where = labelOf(i, id);
    c.oneOf(s, 'kind', where, ['visual', 'meaning']);
    const chars = c.strings(s, 'chars', where);
    if (chars.length < 2) c.error(where, 'needs at least 2 characters');
    for (const ch of chars) if ([...ch].length !== 1 || !isKanji(ch)) c.error(where, `"${ch}" must be one kanji`);
    if (new Set(chars).size !== chars.length) c.error(where, 'characters must be distinct');
    items.push({ id: id ?? String(i), where, fields: [], chars });
  });
  return items;
}

/** Small kana that merge with the kana before them into one sound: きゃ, ティ, ファ. */
const COMBINING_SMALL_KANA = new Set([...'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ']);
const HIRAGANA_RE = /[ぁ-ゖ]/;
const KATAKANA_RE = /[ァ-ヺ]/;

let courseKana: Map<string, KanaEntry> | undefined;

/** The kana course (kana.json), by character. */
export function kanaCourse(): ReadonlyMap<string, KanaEntry> {
  courseKana ??= new Map(buildKanaTable().map((k) => [k.char, k]));
  return courseKana;
}

/**
 * Whether `word` uses `kana` as a sound of its own, not only as the first half
 * of a yōon or extended sound: きゅう has no "ki" in it, ティー no "te".
 */
export function hasOwnKana(word: string, kana: string): boolean {
  const chars = [...word];
  return chars.some((ch, i) => ch === kana && !COMBINING_SMALL_KANA.has(chars[i + 1]));
}

/**
 * content/kana-examples.json: { "け": { kana: "いけ", written?: "池", en: "pond", hook?: "…" } }.
 * Every basic, dakuten and handakuten kana of kana.json gets a short word that
 * uses the kana's own sound, written in the kana's script. Basic kana also get a
 * one-line picture hook (linted in mnemonics.ts).
 */
function checkKanaExamples(data: unknown, c: Checker): ContentItem[] {
  if (!isObj(data)) {
    c.error('file', 'must be an object mapping a kana to its example word');
    return [];
  }
  const course = kanaCourse();
  const items: ContentItem[] = [];
  for (const [char, example] of Object.entries(data)) {
    const where = `"${char}"`;
    const known = course.get(char);
    const entry = known && known.kind !== 'yoon' ? known : undefined;
    if (!entry) c.error(where, 'keys must be basic, dakuten or handakuten kana from kana.json');
    if (!isObj(example)) {
      c.error(where, 'must be an object with "kana" and "en"');
      continue;
    }
    const fields: ContentField[] = [];
    const kana = c.string(example, 'kana', where);
    if (kana !== undefined) {
      fields.push({ path: `${where}.kana`, text: kana, ruby: false });
      if (!isKanaOnly(kana)) c.error(where, `"kana" must be kana only, got "${kana}"`);
      else if (!entry) {
        // Reported above.
      } else if (!hasOwnKana(kana, char)) {
        c.error(where, `"${kana}" must use ${char} on its own${[...kana].includes(char) ? ', not only in a yōon' : ''}`);
      } else if ((entry.script === 'hiragana' ? KATAKANA_RE : HIRAGANA_RE).test(kana)) {
        c.error(where, `"${kana}" must be written in ${entry.script}, like ${char}`);
      }
    }
    const written = c.string(example, 'written', where, true);
    if (written !== undefined) fields.push({ path: `${where}.written`, text: written, ruby: false });
    c.string(example, 'en', where);
    const hook = c.string(example, 'hook', where, true);
    if (hook !== undefined && /\n/.test(hook)) c.error(where, '"hook" must be one line');
    items.push({ id: char, where, fields });
  }
  const missing = [...course.values()].filter((k) => k.kind !== 'yoon' && !Object.hasOwn(data, k.char));
  if (missing.length > 0) {
    c.warn('file', `no example word for ${missing.length} kana: ${missing.map((k) => k.char).join('')}`);
  }
  return items;
}

const CHECKS: Record<ContentKind, (data: unknown, c: Checker) => ContentItem[]> = {
  'core-words': checkCoreWords,
  grammar: checkGrammar,
  units: checkUnits,
  stories: checkStories,
  roleplays: (data, c) => checkRolePlays(data, c),
  sentences: checkSentences,
  mnemonics: checkMnemonics,
  'kana-examples': checkKanaExamples,
  'kana-rules': checkKanaRules,
  confusables: checkConfusables,
};

/** Structural and ruby checks for one content file's parsed JSON. `v1` reads v1 role-plays. */
export function checkContent(kind: ContentKind, data: unknown, v1 = false): ContentReport {
  const c = new Checker();
  const items = kind === 'roleplays' && v1 ? checkRolePlays(data, c, true) : CHECKS[kind](data, c);
  return { items, errors: c.errors, warnings: c.warnings };
}

/** One parsed content file. `file` prefixes its messages: "content/sentences/s1.json". */
export interface ContentSource {
  file: string;
  data: unknown;
}

/** Kinds whose files are merged and then sorted by `order`. */
const ORDERED_KINDS: readonly ContentKind[] = ['core-words', 'grammar'];

/**
 * Checks several files of one kind (content/units/*.json) and merges them in the order given:
 * arrays are concatenated (a file holding one entry counts as an array of one), keyed maps
 * combined. An id (or key) used by two files is an error. Core words and grammar are sorted by order.
 */
export function mergeContent(
  kind: ContentKind,
  sources: readonly ContentSource[],
  v1 = false,
): ContentReport & { data: unknown } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const items: ContentItem[] = [];
  const firstFile = new Map<string, string>();
  const list: unknown[] = [];
  const map: Obj = {};
  const keyed = KEYED_KINDS.includes(kind);
  for (const { file, data } of sources) {
    const entries = keyed || Array.isArray(data) ? data : [data];
    const report = checkContent(kind, entries, v1);
    errors.push(...report.errors.map((e) => `${file} ${e}`));
    warnings.push(...report.warnings.map((w) => `${file} ${w}`));
    items.push(...report.items);
    for (const id of declaredIds(entries)) {
      const first = firstFile.get(id);
      if (first === undefined) firstFile.set(id, file);
      else if (first !== file) errors.push(`${file}: id "${id}" is also used in ${first}`);
    }
    if (Array.isArray(entries)) list.push(...entries);
    else if (isObj(entries)) Object.assign(map, entries);
  }
  if (ORDERED_KINDS.includes(kind)) {
    list.sort((a, b) => Number((a as Obj)?.order ?? 0) - Number((b as Obj)?.order ?? 0));
  }
  if (kind === 'core-words') {
    const set = checkCoreWordSet(list);
    errors.push(...set.errors.map((e) => `core words: ${e}`));
    warnings.push(...set.warnings.map((w) => `core words: ${w}`));
  }
  return { data: keyed ? map : list, items, errors, warnings };
}

function declaredIds(data: unknown): string[] {
  if (isObj(data)) return Object.keys(data);
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) =>
    isObj(entry) && (typeof entry.id === 'string' || typeof entry.id === 'number') ? [String(entry.id)] : [],
  );
}

// ---------------------------------------------------------------------------------------------
// Reading content/: a folder of files or a single file per kind.

const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

/** Where each kind is authored. `folder` wins over `file` unless `fileFirst`; `fallback` is the v1 file. */
const SOURCES: Record<ContentKind, { folder?: string; file?: string; fileFirst?: boolean; fallback?: string; alsoFile?: boolean }> = {
  'core-words': { file: 'core-words.json', folder: 'core-words', fileFirst: true },
  grammar: { file: 'grammar-v2.json', folder: 'grammar-v2', fileFirst: true },
  units: { folder: 'units', file: 'units.json' },
  stories: { folder: 'stories' },
  roleplays: { folder: 'roleplays-v2', file: 'roleplays-v2.json', fallback: 'roleplays.json' },
  sentences: { folder: 'sentences', file: 'sentences.json', alsoFile: true },
  mnemonics: { file: 'mnemonics.json' },
  'kana-examples': { file: 'kana-examples.json' },
  'kana-rules': { file: 'kana-rules.json' },
  confusables: { file: 'confusables.json' },
};

export interface SourceSet {
  kind: ContentKind;
  /** Where it was read from, for messages: 'content/units' or 'content/grammar-v2.json'. */
  label: string;
  sources: ContentSource[];
  errors: string[];
  warnings: string[];
  /** Information only, not a problem: a single file ignored because its folder holds the same content. */
  notes: string[];
  /** Role-plays read from v1 content/roleplays.json (to be upgraded). */
  v1: boolean;
  /** Nothing to read: the kind is published empty. */
  missing: boolean;
}

function parseFile(path: string, root: string, errors: string[]): ContentSource | undefined {
  const file = relative(root, path);
  try {
    return { file, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    errors.push(`${file} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

/** Every *.json file of a folder, sorted by file name (numbers in natural order); other files are ignored. */
export function jsonFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort(naturalOrder)
    .map((name) => join(dir, name));
}

/** Entries of a parsed file (one object or an array) by id. */
function entriesById(data: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const e of Array.isArray(data) ? data : [data]) {
    if (isObj(e) && (typeof e.id === 'string' || typeof e.id === 'number')) out.set(String(e.id), e);
  }
  return out;
}

/**
 * The message for a single file that a folder overrides, naming the ids that differ. `same` is true when the
 * file holds exactly the folder's content (then it is only a note, not a warning).
 */
function staleFileMessage(
  fileLabel: string,
  folderLabel: string,
  file: ContentSource,
  folder: readonly ContentSource[],
): { message: string; same: boolean } {
  const old = entriesById(file.data);
  const now = new Map<string, unknown>();
  for (const s of folder) for (const [id, e] of entriesById(s.data)) now.set(id, e);
  const differ = [...now].filter(([id, e]) => old.has(id) && canonicalJson(old.get(id)) !== canonicalJson(e)).map(([id]) => id);
  const onlyFolder = [...now.keys()].filter((id) => !old.has(id));
  const onlyFile = [...old.keys()].filter((id) => !now.has(id));
  const parts = [
    differ.length ? `${differ.length} differ (${differ.join(', ')})` : '',
    onlyFolder.length ? `only in the folder: ${onlyFolder.join(', ')}` : '',
    onlyFile.length ? `only in the file: ${onlyFile.join(', ')}` : '',
  ].filter(Boolean);
  return {
    message: `${fileLabel} is ignored because ${folderLabel}/ exists${parts.length ? `; ${parts.join('; ')}` : ' (same content)'}`,
    same: parts.length === 0,
  };
}

/**
 * The files of one kind under `contentDir`. Folders are read file by file (every *.json, sorted
 * by name). For units and role-plays the folder wins over the single file, which is ignored with
 * a warning listing the ids whose content differs (only a note when it holds the same content);
 * for core words and grammar the single file wins
 * over its part files; role-plays fall back to v1 content/roleplays.json; sentences read the folder
 * and then content/sentences.json.
 */
export function readContentSources(contentDir: string, kind: ContentKind, root = join(contentDir, '..')): SourceSet {
  const spec = SOURCES[kind];
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const folder = spec.folder ? join(contentDir, spec.folder) : undefined;
  const file = spec.file ? join(contentDir, spec.file) : undefined;
  const hasFolder = !!folder && existsSync(folder);
  const hasFile = !!file && existsSync(file);
  const rel = (p: string) => relative(root, p);
  const read = (paths: string[]) => paths.map((p) => parseFile(p, root, errors)).filter((s): s is ContentSource => !!s);
  const set = (label: string, sources: ContentSource[], v1 = false): SourceSet => ({
    kind, label, sources, errors, warnings, notes, v1, missing: false,
  });

  if (hasFile && (spec.fileFirst || !hasFolder)) {
    const sources = read([file!]);
    if (spec.alsoFile && hasFolder) return set(rel(folder!), [...read(jsonFilesIn(folder!)), ...sources]);
    return set(rel(file!), sources);
  }
  if (hasFolder) {
    const sources = read(jsonFilesIn(folder!));
    if (hasFile && !spec.alsoFile && !spec.fileFirst) {
      const stale = read([file!])[0];
      if (stale) {
        const { message, same } = staleFileMessage(rel(file!), rel(folder!), stale, sources);
        (same ? notes : warnings).push(message);
      }
    }
    if (spec.alsoFile && hasFile) sources.push(...read([file!]));
    return set(rel(folder!), sources);
  }
  if (spec.fallback && existsSync(join(contentDir, spec.fallback))) {
    const path = join(contentDir, spec.fallback);
    warnings.push(`${spec.folder ? `${rel(folder!)}/ and ` : ''}${rel(file ?? path)} are missing; upgrading v1 ${rel(path)}`);
    return set(rel(path), read([path]), true);
  }
  const label = rel(folder ?? file!);
  warnings.push(`${label} is missing; publishing it empty`);
  return { kind, label, sources: [], errors, warnings, notes, v1: false, missing: true };
}

/** Guesses the kind from a file name, falling back to the shape of the data. */
export function detectContentKind(fileName: string, data: unknown): ContentKind | undefined {
  const path = fileName.toLowerCase().replace(/\\/g, '/');
  const base = path.replace(/^.*\//, '');
  if (base.includes('core-word') || path.includes('/core-words/')) return 'core-words';
  if (base.includes('grammar')) return 'grammar';
  if (path.includes('/units/') || base.startsWith('units')) return 'units';
  if (path.includes('/stories/') || base.startsWith('st-')) return 'stories';
  if (base.includes('roleplay') || base.includes('role-play') || path.includes('/roleplays-v2/')) return 'roleplays';
  if (base.includes('sentence') || path.includes('/sentences/')) return 'sentences';
  if (base.includes('mnemonic')) return 'mnemonics';
  if (base.includes('kana-example')) return 'kana-examples';
  if (base.includes('kana-rule')) return 'kana-rules';
  if (base.includes('confusable')) return 'confusables';
  const first = Array.isArray(data) ? data[0] : data;
  if (isObj(data) && !('id' in data)) return Object.values(data).some(isObj) ? 'kana-examples' : 'mnemonics';
  if (!isObj(first)) return undefined;
  if ('coreWordCeiling' in first) return 'units';
  if ('gist' in first) return 'stories';
  if ('drills' in first) return 'grammar';
  if ('lines' in first) return 'roleplays';
  if ('practiceWords' in first) return 'kana-rules';
  if ('chars' in first && 'kind' in first) return 'confusables';
  if ('kana' in first && 'pos' in first) return 'core-words';
  if ('jp' in first) return 'sentences';
  return undefined;
}

/** Distinct kanji (or the item's own curriculum characters) in order of appearance. */
export function itemKanji(item: ContentItem): string[] {
  if (item.chars) return item.chars;
  const seen = new Set<string>();
  for (const f of item.fields) {
    const chars = f.ruby ? kanjiIn(f.text) : [...f.text].filter(isKanji);
    for (const ch of chars) seen.add(ch);
  }
  return [...seen];
}

export interface Unlock {
  /** Highest curriculum unit index among the item's kanji; -1 when it has none. */
  index: number;
  /** The kanji at that index. */
  char?: string;
  /** Kanji that no curriculum unit teaches. */
  missing: string[];
}

export function unlockOf(item: ContentItem, unitIndex: ReadonlyMap<string, number>): Unlock {
  const out: Unlock = { index: -1, missing: [] };
  for (const ch of itemKanji(item)) {
    const at = unitIndex.get(ch);
    if (at === undefined) out.missing.push(ch);
    else if (at > out.index) {
      out.index = at;
      out.char = ch;
    }
  }
  return out;
}

/** Curriculum index of each kanji. */
export function unitIndexOf(units: readonly Pick<CurriculumUnit, 'char' | 'index'>[]): Map<string, number> {
  return new Map(units.map((u) => [u.char, u.index]));
}

const LEADING_HIRAGANA_RE = /^[ぁ-ゖ]+/;
const TRAILING_HIRAGANA_RE = /[ぁ-ゖ]{1,2}$/;
/** Text after a single kanji that may be okurigana or a blank, so its reading can't be judged alone. */
const CONTINUES_RE = /^[ぁ-ゖァ-ヺー＿]/;
const SOKUON_SOURCES = new Set(['つ', 'ち', 'く', 'き']);
/** Text ending in a numeral, so a number after it closes a range: {二|に}、{三日|さんにち}. */
const RANGE_START_RE = /[一二三四五六七八九十][、・]?$/;

/** First kana without its voicing marks, so rendaku (か → が, は → ば/ぱ) still matches. */
const unvoiceFirst = (s: string) => {
  const [first = '', ...rest] = s;
  // NFD splits が into か + a combining voicing mark; keep only the base kana.
  return first.normalize('NFD').charAt(0) + rest.join('');
};

/**
 * Whether a ruby reading is the dictionary reading allowing for the regular
 * sound changes inside compounds: rendaku on the first kana ({係|がかり}) and a
 * final つ/ち/く/き becoming っ ({一|いっ}{回|かい}).
 */
export function readingsAgree(actual: string, expected: string): boolean {
  let a = unvoiceFirst(toHiragana(actual));
  let e = unvoiceFirst(toHiragana(expected));
  if (a === e) return true;
  if (a.endsWith('っ') && SOKUON_SOURCES.has(e.slice(-1))) {
    a = a.slice(0, -1);
    e = e.slice(0, -1);
  }
  return a === e;
}

export interface ReadingMismatch {
  path: string;
  written: string;
  reading: string;
  expected: readonly string[];
}

/**
 * Ruby readings that differ from a dictionary (words.json, or every JMdict
 * reading in check-content) where the ruby base is exactly a word's written
 * form, e.g. {明日|みょうにち} when words.json reads 明日 as あした.
 * Okurigana and a honorific prefix are taken into account: {行|い}く is checked
 * as 行く (いく) and ご{飯|はん} as ご飯 (ごはん), not as the nouns 行 (ぎょう) or
 * 飯 (めし). A single kanji followed by kana or a drill blank that does not
 * complete a known word ({食|た}べたい) is skipped: its reading can't be judged.
 * A number with a counter may be read as one ({五分|ごふん}, not ごぶ "half"),
 * and a day count closing a range with にち ({二|に}、{三日|さんにち}).
 * Core words and kana example words compare their `written` form with their `kana`.
 *
 * `words` are the spellings okurigana or a prefix may complete. With the full
 * JMdict as `readingsByWritten`, pass the common words only: JMdict also lists
 * 今日は (こんにちは) and 様です (ようです), which would swallow
 * {今日|きょう}は and {様|さま}です.
 */
export function readingMismatches(
  item: ContentItem,
  readingsByWritten: ReadonlyMap<string, readonly string[]>,
  words: { has(written: string): boolean } = readingsByWritten,
): ReadingMismatch[] {
  const out: ReadingMismatch[] = [];
  const check = (path: string, written: string, reading: string, endsRange = false) => {
    const expected = readingsByWritten.get(written);
    if (!expected || expected.some((k) => readingsAgree(reading, k)) || isCounterReading(written, reading, endsRange)) {
      return;
    }
    out.push({ path, written, reading, expected });
  };

  for (const f of item.fields) {
    if (!f.ruby) continue;
    const segments = parseRuby(f.text);
    segments.forEach((seg, i) => {
      if (seg.reading === undefined) return;
      const prev = segments[i - 1];
      const next = segments[i + 1];
      const prefix = prev && prev.reading === undefined ? (TRAILING_HIRAGANA_RE.exec(prev.text)?.[0] ?? '') : '';
      const after = next && next.reading === undefined ? next.text : '';
      const okurigana = LEADING_HIRAGANA_RE.exec(after)?.[0] ?? '';
      for (let n = okurigana.length; n >= 0; n--) {
        for (let m = prefix.length; m >= 0; m--) {
          if (n === 0 && m === 0) continue;
          const head = prefix.slice(prefix.length - m);
          const tail = okurigana.slice(0, n);
          const written = head + seg.text + tail;
          if (words.has(written)) return check(f.path, written, head + seg.reading + tail);
        }
      }
      if ([...seg.text].length === 1 && CONTINUES_RE.test(after)) return;
      const before = segments.slice(0, i).map((s) => s.text).join('');
      check(f.path, seg.text, seg.reading, RANGE_START_RE.test(before));
    });
  }
  const written = item.fields.find((f) => f.path.endsWith('.written'));
  const kana = item.fields.find((f) => f.path.endsWith('.kana'));
  if (written && kana) check(written.path, written.text, kana.text);
  return out;
}
