// Validation for the hand-authored files in content/ (grammar, sentences,
// role-plays, survival words, mnemonics, kana example words). Used by
// build-data and check-content.

import { isKanaOnly, isKanji, kanjiIn, parseRuby, validateRuby } from '../../src/lib/ruby.ts';
import type { CurriculumUnit, KanaEntry } from '../../src/lib/types.ts';
import { buildKanaTable } from './kana.ts';
import { isCounterReading, toHiragana } from './readings.ts';

export type ContentKind = 'grammar' | 'sentences' | 'roleplays' | 'survival-words' | 'mnemonics' | 'kana-examples';

export const CONTENT_KINDS: readonly ContentKind[] = [
  'grammar',
  'sentences',
  'roleplays',
  'survival-words',
  'mnemonics',
  'kana-examples',
];

/** Kinds authored as one object keyed by character instead of an array of entries. */
const KEYED_KINDS: readonly ContentKind[] = ['mnemonics', 'kana-examples'];

export function contentFileName(kind: ContentKind): string {
  return `${kind}.json`;
}

/** What an absent content file is replaced with. */
export function emptyContent(kind: ContentKind): unknown[] | Record<string, never> {
  return KEYED_KINDS.includes(kind) ? {} : [];
}

/** A Japanese text field inside an entry. `ruby` fields use {漢字|かな} markup. */
export interface ContentField {
  path: string;
  text: string;
  ruby: boolean;
}

/** One entry of a content file (a sentence, a grammar point, a role-play, …). */
export interface ContentItem {
  id: string;
  /** Location used in messages, e.g. `[3] wa-desu`. */
  where: string;
  fields: ContentField[];
  /** Curriculum characters the item is about directly (a mnemonic's kanji or radical). */
  chars?: string[];
}

export interface ContentReport {
  items: ContentItem[];
  errors: string[];
  warnings: string[];
}

/** The blank in a grammar drill prompt. */
export const DRILL_BLANK = '＿＿';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Collects problems for one file and records the Japanese fields it sees. */
class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private readonly ids = new Set<string>();

  error(where: string, message: string) {
    this.errors.push(`${where}: ${message}`);
  }

  warn(where: string, message: string) {
    this.warnings.push(`${where}: ${message}`);
  }

  string(o: Obj, key: string, where: string, optional = false): string | undefined {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string' || !v.trim()) {
      this.error(where, `"${key}" must be a non-empty string`);
      return undefined;
    }
    return v;
  }

  array(o: Obj, key: string, where: string, optional = false): unknown[] {
    const v = o[key];
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) {
      this.error(where, `"${key}" must be an array`);
      return [];
    }
    return v;
  }

  oneOf<T>(o: Obj, key: string, where: string, allowed: readonly T[]): T | undefined {
    const v = o[key] as T;
    if (!allowed.includes(v)) {
      this.error(where, `"${key}" must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
      return undefined;
    }
    return v;
  }

  id(o: Obj, where: string): string | undefined {
    const id = this.string(o, 'id', where);
    if (id === undefined) return undefined;
    if (this.ids.has(id)) this.error(where, `duplicate id "${id}"`);
    this.ids.add(id);
    return id;
  }

  ruby(o: Obj, key: string, where: string, fields: ContentField[]): string | undefined {
    const text = this.string(o, key, where);
    if (text === undefined) return undefined;
    const path = `${where}.${key}`;
    for (const problem of validateRuby(text)) this.error(path, `${problem} in "${text}"`);
    fields.push({ path, text, ruby: true });
    return text;
  }
}

function labelOf(index: number, id: string | undefined): string {
  return id ? `[${index}] ${id}` : `[${index}]`;
}

function eachObject(data: unknown, c: Checker, what: string, fn: (o: Obj, index: number) => void): void {
  if (!Array.isArray(data)) {
    c.error('file', `must be an array of ${what}`);
    return;
  }
  data.forEach((o, i) => {
    if (isObj(o)) fn(o, i);
    else c.error(`[${i}]`, `each ${what.replace(/s$/, '')} must be an object`);
  });
}

function checkGrammar(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  let lastOrder = -Infinity;
  eachObject(data, c, 'grammar points', (g, i) => {
    const id = c.id(g, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    if (typeof g.order !== 'number') c.error(where, '"order" must be a number');
    else if (g.order < lastOrder) c.warn(where, `"order" ${g.order} is out of sequence (the build sorts by order)`);
    else lastOrder = g.order;
    c.oneOf(g, 'phase', where, [1, 2, 3, 4]);
    c.string(g, 'title', where);
    c.string(g, 'explanation', where);
    c.ruby(g, 'pattern', where, fields);

    const examples = c.array(g, 'examples', where);
    if (examples.length < 3) c.warn(where, `has ${examples.length} examples (3+ expected)`);
    examples.forEach((ex, j) => {
      const at = `${where}.examples[${j}]`;
      if (!isObj(ex)) return c.error(at, 'must be an object');
      c.ruby(ex, 'jp', at, fields);
      c.string(ex, 'en', at);
    });

    const drills = c.array(g, 'drills', where);
    if (drills.length < 4) c.warn(where, `has ${drills.length} drills (4+ expected)`);
    drills.forEach((d, j) => {
      const at = `${where}.drills[${j}]`;
      if (!isObj(d)) return c.error(at, 'must be an object');
      const prompt = c.ruby(d, 'prompt', at, fields);
      if (prompt !== undefined && !prompt.includes(DRILL_BLANK)) c.error(at, `prompt has no blank "${DRILL_BLANK}"`);
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

function checkRolePlays(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'role-plays', (r, i) => {
    const id = c.id(r, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    c.string(r, 'title', where);
    c.ruby(r, 'titleJp', where, fields);
    c.oneOf(r, 'level', where, [1, 2, 3]);
    c.string(r, 'setting', where);
    const roles = r.roles;
    if (!isObj(roles)) c.error(where, '"roles" must be an object with "a" and "b"');
    else {
      for (const key of ['a', 'b'] as const) {
        const role = roles[key];
        const at = `${where}.roles.${key}`;
        if (!isObj(role)) {
          c.error(at, 'must be an object');
          continue;
        }
        c.string(role, 'name', at);
        c.ruby(role, 'nameJp', at, fields);
      }
    }
    const lines = c.array(r, 'lines', where);
    if (lines.length === 0) c.error(where, 'has no lines');
    lines.forEach((line, j) => {
      const at = `${where}.lines[${j}]`;
      if (!isObj(line)) return c.error(at, 'must be an object');
      c.oneOf(line, 'role', at, ['a', 'b']);
      c.ruby(line, 'jp', at, fields);
      c.string(line, 'en', at);
      c.string(line, 'hint', at, true);
    });
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

function checkSurvivalWords(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(data, c, 'survival words', (w, i) => {
    const id = c.id(w, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    const kana = c.string(w, 'kana', where);
    if (kana !== undefined) {
      if (!isKanaOnly(kana)) c.error(where, `"kana" must be kana only, got "${kana}"`);
      fields.push({ path: `${where}.kana`, text: kana, ruby: false });
    }
    const written = c.string(w, 'written', where, true);
    if (written !== undefined) fields.push({ path: `${where}.written`, text: written, ruby: false });
    c.string(w, 'en', where);
    c.string(w, 'note', where, true);
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

function checkMnemonics(data: unknown, c: Checker): ContentItem[] {
  if (!isObj(data)) {
    c.error('file', 'must be an object mapping a character to its memory hook');
    return [];
  }
  const items: ContentItem[] = [];
  for (const [char, hook] of Object.entries(data)) {
    const where = `"${char}"`;
    if ([...char].length !== 1) c.error(where, 'keys must be a single character');
    if (typeof hook !== 'string' || !hook.trim()) c.error(where, 'memory hook must be a non-empty string');
    else if (/\n/.test(hook)) c.warn(where, 'memory hook should be one line');
    items.push({ id: char, where, fields: [], chars: [char] });
  }
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
 * content/kana-examples.json: { "け": { kana: "いけ", written?: "池", en: "pond" } }.
 * Every basic, dakuten and handakuten kana of kana.json gets a short word that
 * uses the kana's own sound, written in the kana's script.
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
    items.push({ id: char, where, fields });
  }
  const missing = [...course.values()].filter((k) => k.kind !== 'yoon' && !Object.hasOwn(data, k.char));
  if (missing.length > 0) {
    c.warn('file', `no example word for ${missing.length} kana: ${missing.map((k) => k.char).join('')}`);
  }
  return items;
}

const CHECKS: Record<ContentKind, (data: unknown, c: Checker) => ContentItem[]> = {
  grammar: checkGrammar,
  sentences: checkSentences,
  roleplays: checkRolePlays,
  'survival-words': checkSurvivalWords,
  mnemonics: checkMnemonics,
  'kana-examples': checkKanaExamples,
};

/** Structural and ruby checks for one content file's parsed JSON. */
export function checkContent(kind: ContentKind, data: unknown): ContentReport {
  const c = new Checker();
  const items = CHECKS[kind](data, c);
  return { items, errors: c.errors, warnings: c.warnings };
}

/** One parsed content file. `file` prefixes its messages: "content/sentences/s1.json". */
export interface ContentSource {
  file: string;
  data: unknown;
}

/**
 * Checks several files of one kind (content/sentences/*.json) and merges them
 * in the order given: arrays are concatenated, mnemonic maps combined. An id
 * (or mnemonic character) used by two files is an error.
 */
export function mergeContent(kind: ContentKind, sources: readonly ContentSource[]): ContentReport & { data: unknown } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const items: ContentItem[] = [];
  const firstFile = new Map<string, string>();
  const list: unknown[] = [];
  const map: Obj = {};
  for (const { file, data } of sources) {
    const report = checkContent(kind, data);
    errors.push(...report.errors.map((e) => `${file} ${e}`));
    warnings.push(...report.warnings.map((w) => `${file} ${w}`));
    items.push(...report.items);
    for (const id of declaredIds(data)) {
      const first = firstFile.get(id);
      if (first === undefined) firstFile.set(id, file);
      else if (first !== file) errors.push(`${file}: id "${id}" is also used in ${first}`);
    }
    if (Array.isArray(data)) list.push(...data);
    else if (isObj(data)) Object.assign(map, data);
  }
  return { data: KEYED_KINDS.includes(kind) ? map : list, items, errors, warnings };
}

function declaredIds(data: unknown): string[] {
  if (isObj(data)) return Object.keys(data);
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => (isObj(entry) && typeof entry.id === 'string' ? [entry.id] : []));
}

/** Guesses the kind from a file name, falling back to the shape of the data. */
export function detectContentKind(fileName: string, data: unknown): ContentKind | undefined {
  const base = fileName.toLowerCase().replace(/^.*[\\/]/, '');
  if (base.includes('grammar')) return 'grammar';
  if (base.includes('sentence')) return 'sentences';
  if (base.includes('roleplay') || base.includes('role-play')) return 'roleplays';
  if (base.includes('survival')) return 'survival-words';
  if (base.includes('mnemonic')) return 'mnemonics';
  if (base.includes('kana-example')) return 'kana-examples';
  if (isObj(data)) return Object.values(data).some(isObj) ? 'kana-examples' : 'mnemonics';
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!isObj(first)) return undefined;
  if ('drills' in first) return 'grammar';
  if ('lines' in first) return 'roleplays';
  if ('kana' in first) return 'survival-words';
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

export interface LateGrammar {
  /** Sentence id. */
  id: string;
  grammar: string;
  grammarPhase: number;
  /** Phase of the unit that unlocks the sentence; 1 for kana-only sentences. */
  unlockPhase: number;
}

/**
 * Grammar tags a learner can meet before the grammar is taught: the sentence
 * unlocks (its last kanji is taught) in an earlier phase than the tagged
 * point's. Unknown grammar ids and untaught kanji are reported elsewhere.
 */
export function lateGrammarTags(
  sentences: unknown,
  units: readonly Pick<CurriculumUnit, 'char' | 'index' | 'phase'>[],
  grammarPhase: ReadonlyMap<string, number>,
): LateGrammar[] {
  if (!Array.isArray(sentences)) return [];
  const unitOf = new Map(units.map((u) => [u.char, u]));
  const out: LateGrammar[] = [];
  for (const s of sentences) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.jp !== 'string' || !Array.isArray(s.grammar)) continue;
    let unlockPhase = 1;
    let last = -1;
    for (const ch of kanjiIn(s.jp)) {
      const unit = unitOf.get(ch);
      if (unit && unit.index > last) [last, unlockPhase] = [unit.index, unit.phase];
    }
    for (const grammar of s.grammar) {
      const phase = typeof grammar === 'string' ? grammarPhase.get(grammar) : undefined;
      if (phase !== undefined && phase > unlockPhase) out.push({ id: s.id, grammar, grammarPhase: phase, unlockPhase });
    }
  }
  return out;
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
 * Survival words and kana example words compare their `written` form with their `kana`.
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
