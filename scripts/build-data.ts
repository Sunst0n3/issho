// Builds the static study data in public/data/ from data-raw/ (KanjiVG, KANJIDIC2, JMdict) and
// the hand-authored files in content/ (TECH-DESIGN §3.6.1). Audio and accent.json come from
// scripts/audio/generate.ts.
//
//   node scripts/build-data.ts                    (npm run build:data)
//   node scripts/build-data.ts --lock-core-ids    (at release: freeze the core ids)
//
// Structural problems in content (bad JSON, missing fields, duplicate ids, broken ruby, unknown
// references) fail the build; content that is still being written only warns.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rubyToKana } from '../src/lib/ruby.ts';
import type {
  ConfusableSet,
  CoreWord,
  Curriculum,
  GrammarBuildItem,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicsFile,
  RadicalEntry,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  StrokesFile,
  UnitSpec,
  WordEntry,
  WordRef,
} from '../src/lib/types.ts';
import { buildAnswers } from './lib/answers.ts';
import { isObj, type Obj } from './lib/checker.ts';
import {
  CONTENT_KINDS,
  PLAIN_FORM_MAX_ORDER,
  checkGrammarSet,
  contentFileName,
  itemKanji,
  kanaCourse,
  kanaRuleScript,
  latePlainForms,
  mergeContent,
  readContentSources,
  type ContentItem,
  type ContentKind,
  type SourceSet,
} from './lib/content.ts';
import {
  checkCoreIdLock,
  deriveCoreWord,
  kanaCheckWords,
  makeCoreIdLock,
  type AuthoredCoreWord,
  type CoreIdLock,
} from './lib/core.ts';
import { buildCurriculum, kanjiBoosts, MAX_UNIT_WORDS, type UnitCandidate } from './lib/curriculum.ts';
import { mapGrammarTags } from './lib/grammar-map.ts';
import { linkCoreWords, wordRef } from './lib/identity.ts';
import { readJMdict, type JmEntry } from './lib/jmdict.ts';
import { buildKanaTable, isStrokeKana } from './lib/kana.ts';
import { readKanjidic, type KanjidicEntry } from './lib/kanjidic.ts';
import {
  componentCount,
  componentsOf,
  descendants,
  elementStrokes,
  hasPhoneticComponent,
  ignoredElements,
  readKanjiVG,
  type KvgChar,
} from './lib/kanjivg.ts';
import { hookContext, lintKanaHooks, lintMnemonics, normalizeMnemonics } from './lib/mnemonics.ts';
import { contentRefs, toPreTokens } from './lib/pretoken.ts';
import { buildRolePlays } from './lib/roleplays.ts';
import { buildStory, sortStories } from './lib/stories.ts';
import { buildUnits, grammarUnits } from './lib/units.ts';
import { WORD_OVERRIDES } from './lib/word-overrides.ts';
import { coreAltKana, nfRank, priorityTags, selectWord } from './lib/words.ts';
import { loadTokenizer, type RubyToken, type RubyTokenizer } from './v2/tokenize.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RAW = join(ROOT, 'data-raw');
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'public', 'data');
const CORE_LOCK = join(ROOT, 'scripts', 'data', 'core-ids.lock.json');

/** The raw dictionaries in data-raw/ and where to get them. */
const RAW_FILES = {
  kanjivg: ['kanjivg.xml.gz', 'https://github.com/KanjiVG/kanjivg/releases (kanjivg-YYYYMMDD.xml.gz)'],
  kanjidic: ['kanjidic2.xml.gz', 'http://www.edrdg.org/kanjidic/kanjidic2.xml.gz'],
  jmdict: ['JMdict_e.gz', 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz'],
} as const;

/** Published files of earlier builds that v2 no longer writes. */
const RETIRED_OUTPUTS = ['content/survival-words.json'];

/** An ignored KanjiVG component used by this many jōyō kanji should get a name in content/radicals.json. */
const COMMON_COMPONENT_USERS = 20;

class BuildError extends Error {}

const warnings: string[] = [];
const infos: string[] = [];
const warn = (message: string) => warnings.push(message);

function fail(problems: readonly string[], what: string): void {
  if (problems.length > 0) throw new BuildError(`${what} has ${problems.length} error(s):\n  ${problems.join('\n  ')}`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new BuildError(`${relative(ROOT, path)} is not valid JSON: ${(err as Error).message}`);
  }
}

function rawPath(key: keyof typeof RAW_FILES): string {
  const [file, source] = RAW_FILES[key];
  const path = join(RAW, file);
  if (!existsSync(path)) throw new BuildError(`data-raw/${file} is missing. Download it from ${source}`);
  return path;
}

// ---------------------------------------------------------------------------------------------
// Step 2: content/

interface LoadedKind {
  set: SourceSet;
  data: unknown;
  items: ContentItem[];
}

/** Reads and structurally checks every content kind, so a typo fails fast, before the slow parsing. */
function loadContent(): Record<ContentKind, LoadedKind> {
  const errors: string[] = [];
  const loaded = {} as Record<ContentKind, LoadedKind>;
  for (const kind of CONTENT_KINDS) {
    const set = readContentSources(CONTENT, kind, ROOT);
    errors.push(...set.errors);
    for (const w of set.warnings) warn(w);
    infos.push(...set.notes);
    const merged = mergeContent(kind, set.sources, set.v1);
    errors.push(...merged.errors);
    for (const w of merged.warnings) warn(w);
    loaded[kind] = { set, data: merged.data, items: merged.items };
  }
  const grammar = loaded.grammar.data as Obj[];
  if (grammar.length > 0) {
    const set = checkGrammarSet(grammar);
    errors.push(...set.errors.map((e) => `${loaded.grammar.set.label}: ${e}`));
    for (const w of set.warnings) warn(w);
  }
  fail(errors, 'content');
  return loaded;
}

// ---------------------------------------------------------------------------------------------
// content/radicals.json: names for named parts

function loadRadicals(kvg: Map<string, KvgChar>, kanjidic: Map<string, KanjidicEntry>): RadicalEntry[] {
  const path = join(CONTENT, 'radicals.json');
  if (!existsSync(path)) {
    warn('content/radicals.json is missing; named parts get KANJIDIC names only');
    return [];
  }
  const data = readJson(path);
  if (!Array.isArray(data)) throw new BuildError('content/radicals.json must be an array');

  const elements = new Set<string>();
  for (const c of kvg.values()) for (const g of descendants(c.root)) if (g.element) elements.add(g.element);

  const errors: string[] = [];
  const seen = new Set<string>();
  const radicals: RadicalEntry[] = [];
  for (const [i, r] of (data as Partial<RadicalEntry>[]).entries()) {
    const where = `content/radicals.json [${i}] ${r?.char ?? ''}`;
    if (typeof r?.char !== 'string' || [...r.char].length !== 1) {
      errors.push(`${where}: "char" must be one character`);
      continue;
    }
    if (typeof r.name !== 'string' || !r.name) errors.push(`${where}: "name" is required`);
    if (typeof r.meaning !== 'string' || !r.meaning) errors.push(`${where}: "meaning" is required`);
    if (seen.has(r.char)) errors.push(`${where}: duplicate radical`);
    // A jōyō kanji here names it where it is a rare component (乙, 斤); other entries must be KanjiVG elements.
    if (!kanjidic.has(r.char) && !elements.has(r.char)) errors.push(`${where}: KanjiVG never uses it as an element`);
    if (r.variantOf !== undefined && !kanjidic.has(r.variantOf)) warn(`${where}: variantOf "${r.variantOf}" is not a jōyō kanji`);
    seen.add(r.char);
    const entry: RadicalEntry = { char: r.char, name: r.name!, meaning: r.meaning! };
    if (r.variantOf) entry.variantOf = r.variantOf;
    radicals.push(entry);
  }
  fail(errors, 'content/radicals.json');
  return radicals;
}

// ---------------------------------------------------------------------------------------------
// Output

const outputs: { file: string; bytes: number; gzip: number }[] = [];

/**
 * JSON with one array entry (or object member) per line: about half the size of 2-space JSON for
 * the large generated files (words, strokes, stories), which phones keep decoded in the service
 * worker's cache, while a rebuild still diffs line by line.
 */
function jsonLines(data: unknown): string {
  if (Array.isArray(data)) return data.length ? `[\n${data.map((v) => JSON.stringify(v)).join(',\n')}\n]\n` : '[]\n';
  if (data && typeof data === 'object') {
    const members = Object.entries(data).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    return members.length ? `{\n${members.join(',\n')}\n}\n` : '{}\n';
  }
  return `${JSON.stringify(data)}\n`;
}

function writeJson(file: string, data: unknown, format: 'pretty' | 'lines' = 'pretty'): void {
  const path = join(OUT, file);
  mkdirSync(join(path, '..'), { recursive: true });
  const json = format === 'lines' ? jsonLines(data) : `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, json);
  const bytes = Buffer.byteLength(json);
  outputs.push({ file, bytes, gzip: gzipSync(json).length });
}

const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;

/** words.json entries in the published key order. */
function publishedWord(w: WordEntry): WordEntry {
  const out: WordEntry = {
    id: w.id,
    written: w.written,
    kana: w.kana,
    meanings: w.meanings,
    pos: w.pos,
    freqRank: w.freqRank,
    kanji: w.kanji,
  };
  if (w.pri?.length) out.pri = w.pri;
  if (w.core) out.core = w.core;
  if (w.use) out.use = true;
  if (w.altKana?.length) out.altKana = w.altKana;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report: anchors compared with the previous build

/** char → "written kana" of the first taught word in the curriculum currently in public/data. */
function previousAnchors(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const curriculum = JSON.parse(readFileSync(join(OUT, 'curriculum.json'), 'utf8')) as {
      units: { char: string; words?: string[]; anchor?: WordRef | null }[];
    };
    const words = new Map(
      (JSON.parse(readFileSync(join(OUT, 'words.json'), 'utf8')) as WordEntry[]).map((w) => [w.id, `${w.written} ${w.kana}`]),
    );
    const corePath = join(OUT, 'content', 'core-words.json');
    const core = existsSync(corePath)
      ? new Map((JSON.parse(readFileSync(corePath, 'utf8')) as CoreWord[]).map((w) => [w.id, `${w.written ?? w.kana} ${w.kana}`]))
      : new Map<string, string>();
    for (const u of curriculum.units) {
      const ref = u.anchor ?? (u.words?.[0] ? `word:${u.words[0]}` : null);
      if (!ref) continue;
      const shown = ref.startsWith('core:') ? core.get(ref.slice(5)) : words.get(ref.slice(5));
      if (shown) out.set(u.char, shown);
    }
  } catch {
    // No previous build, or an unreadable one: nothing to compare.
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

interface JmdictScan {
  words: WordEntry[];
  /** Full entries named by core words' `jmdict`. */
  coreEntries: Map<string, JmEntry>;
  /** Kana-only core word kana → the first entry whose reading list starts with it and that has a kanji spelling. */
  usualKanji: Map<string, string>;
  /** words.json ids whose sense is derogatory, sensitive or slang: never taught with a kanji. */
  offensive: Set<string>;
  entries: number;
}

async function scanJMdict(path: string, isJoyo: (ch: string) => boolean, core: readonly AuthoredCoreWord[]): Promise<JmdictScan> {
  const wanted = new Set(core.flatMap((c) => (c.jmdict ? [c.jmdict] : [])));
  const kanaOnly = new Set(core.filter((c) => !c.written).map((c) => c.kana));
  const scan: JmdictScan = { words: [], coreEntries: new Map(), usualKanji: new Map(), offensive: new Set(), entries: 0 };
  await readJMdict(path, (e) => {
    scan.entries++;
    if (wanted.has(e.id)) scan.coreEntries.set(e.id, structuredClone(e));
    const first = e.readings[0]?.text;
    if (first && e.kanji.length > 0 && kanaOnly.has(first) && !scan.usualKanji.has(first)) scan.usualKanji.set(first, e.id);
    const selected = selectWord(e, isJoyo);
    if (!selected) return;
    scan.words.push(selected.word);
    if (selected.offensive) scan.offensive.add(e.id);
  });
  scan.words.sort((a, b) => Number(a.id) - Number(b.id));
  return scan;
}

/** A core word with no words.json entry as a curriculum candidate (its JMdict priorities when it has an entry). */
function coreCandidate(c: CoreWord, entry: JmEntry | undefined, targets: ReadonlySet<string>): UnitCandidate {
  const spelling = entry?.kanji.find((k) => k.text === c.written);
  const reading = entry?.readings.find((r) => r.text === c.kana) ?? entry?.readings[0];
  const pri = reading ? priorityTags(spelling, reading) : [];
  return {
    ref: `core:${c.id}`,
    id: c.id,
    written: c.written ?? c.kana,
    kana: c.kana,
    kanji: c.kanji,
    pos: entry?.senses[0]?.pos ?? [],
    meanings: [c.en],
    pri,
    freqRank: (spelling && nfRank(spelling.pri)) ?? (pri.length ? 49 : 99),
    core: true,
    coreOrder: c.order,
    target: targets.has(c.id),
  };
}

function tokenizeAll(tk: RubyTokenizer): (text: string) => RubyToken[] {
  const cache = new Map<string, RubyToken[]>();
  return (text: string) => {
    let tokens = cache.get(text);
    if (!tokens) cache.set(text, (tokens = tk.tokenize(text)));
    return tokens;
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const lockCoreIds = process.argv.includes('--lock-core-ids');
  const paths = { kanjivg: rawPath('kanjivg'), kanjidic: rawPath('kanjidic'), jmdict: rawPath('jmdict') };
  const previous = previousAnchors();

  // Step 2: every content file, structurally.
  const content = loadContent();
  const authoredCore = content['core-words'].data as AuthoredCoreWord[];
  const rawUnits = content.units.data as Obj[];
  const unitCeilings = rawUnits.map((u) => ({ id: Number(u.id), coreWordCeiling: Number(u.coreWordCeiling) }));
  const rawGrammar = content.grammar.data as Obj[];
  const grammarOrder = new Map(rawGrammar.map((g) => [String(g.id), Number(g.order)]));

  // Step 1: raw dictionaries.
  const [kvg, kanjidic] = await Promise.all([readKanjiVG(paths.kanjivg), readKanjidic(paths.kanjidic)]);
  console.log(`KanjiVG: ${kvg.size} characters; KANJIDIC2: ${kanjidic.size} jōyō kanji`);
  const radicals = loadRadicals(kvg, kanjidic);
  const radicalByChar = new Map(radicals.map((r) => [r.char, r]));
  const isJoyo = (ch: string) => kanjidic.has(ch);
  const jm = await scanJMdict(paths.jmdict, isJoyo, authoredCore);
  console.log(`JMdict: ${jm.entries} entries → ${jm.words.length} common words`);
  const missingIds = authoredCore.filter((c) => c.jmdict && !jm.coreEntries.has(c.jmdict));
  for (const c of missingIds) warn(`core word ${c.id} ${c.written ?? c.kana}: JMdict has no entry ${c.jmdict}`);

  // Step 3: core words.
  const siblingKana = new Map<string, Set<string>>();
  for (const c of authoredCore) {
    if (!c.jmdict) continue;
    const set = siblingKana.get(c.jmdict) ?? new Set<string>();
    set.add(c.kana);
    siblingKana.set(c.jmdict, set);
  }
  const core: CoreWord[] = authoredCore.map((c) => {
    const siblings = new Set([...(siblingKana.get(c.jmdict ?? '') ?? [])].filter((k) => k !== c.kana));
    return deriveCoreWord(c, unitCeilings, coreAltKana(c, c.jmdict ? jm.coreEntries.get(c.jmdict) : undefined, siblings));
  });
  const coreById = new Map(core.map((c) => [c.id, c]));
  const coreIds = new Set(core.map((c) => c.id));
  if (existsSync(CORE_LOCK)) {
    fail(checkCoreIdLock(readJson(CORE_LOCK) as CoreIdLock, core), 'scripts/data/core-ids.lock.json');
  }

  // Step 4: word identity, then words.json fields.
  const links = linkCoreWords(core, jm.words, (kana) => jm.usualKanji.get(kana));
  const words = jm.words;
  for (const w of words) {
    const id = links.get(w.id);
    if (id) w.core = id;
  }
  const linkedCore = new Set(links.values());
  const tk = await loadTokenizer({
    core: core.map((c) => ({ id: c.id, order: c.order, kana: c.kana, written: c.written, pos: c.pos, jmdict: c.jmdict })),
    words: words.map((w) => ({ id: w.id, written: w.written, kana: w.kana, pos: w.pos, freqRank: w.freqRank })),
  });
  const tokenize = tokenizeAll(tk);
  const writtenById = new Map(words.map((w) => [w.id, w.written]));
  const writtenOf = (id: string) => writtenById.get(id);
  const refsOf = (text: string) => toPreTokens(tokenize(text), links, { writtenOf });

  // Role-play and task material, for `use` (JMdict words the learner says) and target boosts.
  const rolePlaySet = content.roleplays;
  const rawRolePlays = (rolePlaySet.data as unknown[]).filter(isObj);
  const lines: string[] = [];
  const targets = new Set<string>();
  for (const r of rawRolePlays) {
    for (const l of Array.isArray(r.lines) ? r.lines : []) if (isObj(l) && typeof l.jp === 'string') lines.push(l.jp);
    for (const t of Array.isArray(r.targets) ? r.targets : []) if (typeof t === 'string' && t.startsWith('core:')) targets.add(t.slice(5));
  }
  for (const u of rawUnits) {
    const task = isObj(u.task) ? u.task : {};
    for (const l of Array.isArray(task.scripted) ? task.scripted : []) if (isObj(l) && typeof l.jp === 'string') lines.push(l.jp);
    for (const t of Array.isArray(task.targets) ? task.targets : []) if (typeof t === 'string' && t.startsWith('core:')) targets.add(t.slice(5));
  }
  const spoken = new Set<string>();
  for (const line of lines) {
    for (const t of refsOf(line)) if (t.k === 'c' && !t.name && t.ref?.startsWith('word:')) spoken.add(t.ref.slice(5));
  }
  for (const w of words) if (spoken.has(w.id) && !w.core) w.use = true;

  // Step 5: curriculum v2, kanji.json and the named parts.
  const isTeachable = (el: string) => kanjidic.has(el) || radicalByChar.has(el);
  const components = new Map<string, string[]>();
  const componentCounts = new Map<string, number>();
  const phonetic = new Set<string>();
  const ignoredBy = new Map<string, Set<string>>();
  for (const k of kanjidic.keys()) {
    const glyph = kvg.get(k);
    if (!glyph) {
      warn(`KanjiVG has no entry for jōyō kanji ${k}; it gets no components or strokes`);
      continue;
    }
    components.set(k, componentsOf(glyph, isTeachable));
    componentCounts.set(k, componentCount(glyph, isTeachable));
    if (hasPhoneticComponent(glyph)) phonetic.add(k);
    // Lone strokes (丿 丶 丨) are KanjiVG elements too, but not parts worth a name.
    for (const g of ignoredElements(glyph, isTeachable)) {
      if (g.strokes.length < 2) continue;
      let users = ignoredBy.get(g.element!);
      if (!users) ignoredBy.set(g.element!, (users = new Set()));
      users.add(k);
    }
  }
  for (const [el, users] of ignoredBy) {
    if (users.size < COMMON_COMPONENT_USERS) continue;
    warn(`component ${el} is used by ${users.size} jōyō kanji (${[...users].slice(0, 8).join('')}…) but is not in content/radicals.json`);
  }

  const confusableErrors: string[] = [];
  const confusables = (content.confusables.data as ConfusableSet[]).map((s) => {
    const unknown = s.chars.filter((ch) => !kanjidic.has(ch));
    if (unknown.length > 0) confusableErrors.push(`${s.id}: ${unknown.join('')} ${unknown.length > 1 ? 'are not jōyō kanji' : 'is not a jōyō kanji'}`);
    return { id: s.id, chars: s.chars, kind: s.kind };
  });
  fail(confusableErrors, content.confusables.set.label);

  // Curriculum candidates: words.json entries under their item ref (a core word keeps its own
  // spelling; one usually written in kana is never a kanji's word), plus core words with no entry.
  const candidates: UnitCandidate[] = [];
  for (const w of words) {
    const c = w.core ? coreById.get(w.core) : undefined;
    if ((c && !c.written) || (!c && jm.offensive.has(w.id))) continue;
    candidates.push({
      ref: wordRef(w.id, links),
      id: w.id,
      written: c?.written ?? w.written,
      kana: c?.kana ?? w.kana,
      kanji: c ? c.kanji : w.kanji,
      pos: w.pos,
      meanings: w.meanings,
      pri: w.pri ?? [],
      freqRank: w.freqRank,
      core: !!c,
      coreOrder: c?.order,
      target: !!c && targets.has(c.id),
    });
  }
  for (const c of core) {
    if (linkedCore.has(c.id) || c.kanji.length === 0) continue;
    candidates.push(coreCandidate(c, c.jmdict ? jm.coreEntries.get(c.jmdict) : undefined, targets));
  }
  const targetWords = [...targets].flatMap((id) => coreById.get(id)?.written ?? []);
  const built = buildCurriculum({
    kanji: [...kanjidic.values()],
    components,
    words: candidates,
    boosts: kanjiBoosts(core, targetWords),
    phonetic,
    componentCounts,
    confusables,
    overrides: WORD_OVERRIDES,
    warn,
  });
  const curriculum: Curriculum = built.curriculum;
  const unitIndex = new Map(curriculum.units.map((u) => [u.char, u.index]));

  const kanjiOut: Record<string, KanjiEntry> = {};
  let strokeCountFixes = 0;
  for (const u of curriculum.units) {
    const k = kanjidic.get(u.char)!;
    const drawn = kvg.get(u.char)?.strokes.length;
    if (drawn !== undefined && drawn !== k.strokeCount) strokeCountFixes++;
    const entry: KanjiEntry = {
      char: k.char,
      meanings: k.meanings,
      on: k.on,
      kun: k.kun,
      // Match the strokes the writing pad draws when the dictionaries disagree.
      strokeCount: drawn ?? k.strokeCount,
    } as KanjiEntry;
    if (k.grade !== undefined) entry.grade = k.grade;
    if (k.jlptOld !== undefined) entry.jlptOld = k.jlptOld;
    if (k.freq !== undefined) entry.freq = k.freq;
    entry.components = built.components.get(u.char) ?? [];
    entry.parts = built.parts.get(u.char) ?? [];
    entry.rank = u.index + 1;
    kanjiOut[u.char] = entry;
  }
  if (strokeCountFixes > 0) console.log(`Stroke counts taken from KanjiVG where KANJIDIC2 differs: ${strokeCountFixes} kanji`);

  // Named parts, in order of first use: content/radicals.json names, else the KANJIDIC keyword.
  const namedParts: RadicalEntry[] = [];
  const partHost = new Map<string, string>();
  for (const u of curriculum.units) {
    for (const p of kanjiOut[u.char].parts) {
      if (partHost.has(p)) continue;
      partHost.set(p, u.char);
      const named = radicalByChar.get(p);
      const k = kanjidic.get(p);
      if (named) namedParts.push(named);
      else if (k) namedParts.push({ char: p, name: k.meanings[0], meaning: k.meanings[0] });
      else warn(`named part ${p} (in ${u.char}) has no name`);
    }
  }
  for (const r of radicals) {
    if (!partHost.has(r.char) && !kanjidic.has(r.char)) warn(`radical ${r.char} (${r.name}) is never used by a curriculum kanji`);
  }

  const strokes: StrokesFile = {};
  for (const [ch, glyph] of kvg) if (isStrokeKana(ch)) strokes[ch] = glyph.strokes;
  for (const u of curriculum.units) {
    const paths = kvg.get(u.char)?.strokes;
    if (paths && paths.length > 0) strokes[u.char] = paths;
    else warn(`no stroke data for kanji ${u.char}`);
  }
  for (const [p, host] of partHost) {
    if (strokes[p]) continue;
    // No KanjiVG entry of its own: take it from the first kanji that uses it.
    const hostGlyph = kvg.get(host);
    const paths = kvg.get(p)?.strokes ?? (hostGlyph ? elementStrokes(hostGlyph, p) : undefined);
    if (paths && paths.length > 0) strokes[p] = paths;
    else warn(`no stroke data for named part ${p}`);
  }

  // Step 7 (before grammar, which takes `unit` from the units): units.
  const conversations = new Map<string, number>();
  for (const u of rawUnits) if (typeof u.conversation === 'string' && u.conversation) conversations.set(u.conversation, Number(u.id));
  const rolePlayIds = new Set(rawRolePlays.map((r) => String(r.id)));
  const unitResult = buildUnits(rawUnits, { grammarOrder, coreIds, rolePlayIds: rolePlaySet.set.missing ? null : rolePlayIds });
  fail(unitResult.errors, content.units.set.label);
  for (const w of unitResult.warnings) warn(w);
  const units: UnitSpec[] = unitResult.units;
  const unitOfGrammar = grammarUnits(units);

  // Step 6: grammar.
  const grammar: GrammarPoint[] = rawGrammar.map((g) => {
    const id = String(g.id);
    const unit = unitOfGrammar.get(id);
    if (unit === undefined && units.length > 0) warn(`grammar ${id} is in no unit`);
    const buildItems = (Array.isArray(g.buildItems) ? g.buildItems : []).filter(isObj).map((b, i): GrammarBuildItem => {
      const item = { en: String(b.en), jp: String(b.jp), tiles: b.tiles as string[], alternatives: b.alternatives as string[] };
      const { answers, unread } = buildAnswers(item, tokenize, rubyToKana);
      for (const alt of unread) warn(`grammar ${id} build item ${i}: could not read the alternative "${alt}"; it is not a typed answer`);
      return { ...item, answers };
    });
    const out = {
      id,
      order: Number(g.order),
      level: g.level,
      title: g.title,
      pattern: g.pattern,
      register: g.register,
      ...(g.recognitionOnly === true ? { recognitionOnly: true } : {}),
      prerequisites: g.prerequisites,
      contrastWith: g.contrastWith,
      explanation: g.explanation,
      examples: g.examples,
      buildItems,
      drills: g.drills,
      unit: unit ?? 1,
    };
    return out as GrammarPoint;
  });
  const late = latePlainForms(grammar);
  if (late.length > 0) {
    infos.push(
      `plain forms come at grammar order ${late.map((g) => `${g.id} #${g.order}`).join(', ')} ` +
        `(plan change 7 aims for ≤ #${PLAIN_FORM_MAX_ORDER}, about course day 60); kept as authored`,
    );
  }

  // Kana rules: script, and the day-14 kana check words on the last rule.
  const rawRules = content['kana-rules'].data as Obj[];
  const kanaRules: KanaRule[] = [...rawRules]
    .sort((a, b) => Number(a.day) - Number(b.day))
    .map((r) => {
      const rule = {
        id: r.id,
        day: r.day,
        script: kanaRuleScript(String(r.id)),
        title: r.title,
        explanation: r.explanation,
        pairs: r.pairs,
        practiceWords: r.practiceWords,
      } as KanaRule;
      if (rule.id === 'kata-extended') rule.checkWords = kanaCheckWords(core);
      return rule;
    });
  const lastRule = kanaRules.find((r) => r.id === 'kata-extended');
  if (lastRule && (lastRule.checkWords?.length ?? 0) < 10) warn(`kana check has only ${lastRule.checkWords?.length ?? 0} katakana core words`);

  // Step 8: role-plays.
  const rp = buildRolePlays(rawRolePlays, { grammarOrder, coreIds, conversations }, rolePlaySet.set.v1);
  fail(rp.errors, rolePlaySet.set.label);
  for (const w of rp.warnings) warn(w);
  const rolePlays: RolePlay[] = rp.rolePlays;

  // Step 9: study sentences.
  const sentences: SentenceEntry[] = [];
  let dropped = 0;
  for (const s of content.sentences.data as Obj[]) {
    const id = String(s.id);
    const tags = mapGrammarTags(Array.isArray(s.grammar) ? s.grammar.filter((g): g is string => typeof g === 'string') : []);
    const unknown = tags.filter((g) => !grammarOrder.has(g));
    if (unknown.length > 0) {
      warn(`sentence ${id} is dropped: unknown grammar ${unknown.map((g) => `"${g}"`).join(', ')}`);
      dropped++;
      continue;
    }
    const tokens = refsOf(String(s.jp));
    const refs = contentRefs(tokens);
    let unit = 1;
    for (const g of tags) unit = Math.max(unit, unitOfGrammar.get(g) ?? 1);
    for (const r of refs) if (r.startsWith('core:')) unit = Math.max(unit, coreById.get(r.slice(5))?.unit ?? 1);
    sentences.push({ id, jp: String(s.jp), en: String(s.en), grammar: tags, tokens, refs, unit });
  }

  // Step 10: stories.
  const unitInfo = new Map(
    units.map((u) => [
      u.id,
      { coreWordCeiling: u.coreWordCeiling, lastGrammar: Math.max(0, ...u.grammar.map((g) => grammarOrder.get(g) ?? 0)) },
    ]),
  );
  const coreOrder = new Map(core.map((c) => [c.id, c.order]));
  const storyErrors: string[] = [];
  const stories: StoryEntry[] = [];
  for (const raw of (content.stories.data as unknown[]).filter(isObj)) {
    const result = buildStory(raw, { tokenize, links, writtenOf, grammarOrder, units: unitInfo, coreOrder });
    storyErrors.push(...result.errors);
    for (const w of result.warnings) warn(w);
    stories.push(result.story);
  }
  fail(storyErrors, content.stories.set.label);
  sortStories(stories);

  // Step 11: mnemonics and kana hooks (lint warnings).
  const mnemonics: MnemonicsFile = normalizeMnemonics(content.mnemonics.data as Record<string, unknown>);
  const hookProblems = lintMnemonics(mnemonics, hookContext(curriculum.units, kanjiOut, namedParts));
  const kanaExamples = content['kana-examples'].data as Record<string, { hook?: string }>;
  const basicKana = [...kanaCourse().values()].filter((k) => k.kind === 'basic').map((k) => k.char);
  hookProblems.push(...lintKanaHooks(kanaExamples, basicKana));
  if (hookProblems.length > 0) {
    warn(`memory hooks: ${hookProblems.length} problem(s), for example:\n      ${hookProblems.slice(0, 8).join('\n      ')}`);
  }
  for (const item of content.mnemonics.items) {
    for (const ch of itemKanji(item)) if (!unitIndex.has(ch) && !partHost.has(ch)) warn(`content/mnemonics.json: "${ch}" is not a curriculum kanji or named part`);
  }

  // Step 12: write.
  if (lockCoreIds) {
    mkdirSync(join(CORE_LOCK, '..'), { recursive: true });
    writeFileSync(CORE_LOCK, `${JSON.stringify(makeCoreIdLock(core), null, 2)}\n`);
    console.log(`Locked ${core.length} core ids in ${relative(ROOT, CORE_LOCK)}`);
  }
  const kana: KanaEntry[] = buildKanaTable();
  for (const k of kana) if ([...k.char].length === 1 && !strokes[k.char]) warn(`no stroke data for kana ${k.char}`);

  writeJson('kana.json', kana);
  writeJson('kanji.json', kanjiOut);
  writeJson('radicals.json', namedParts);
  writeJson('words.json', words.map(publishedWord), 'lines');
  writeJson('curriculum.json', curriculum);
  writeJson('strokes.json', strokes, 'lines');
  writeJson(`content/${contentFileName('core-words')}`, core);
  writeJson(`content/${contentFileName('kana-rules')}`, kanaRules);
  writeJson(`content/${contentFileName('kana-examples')}`, kanaExamples);
  writeJson('content/grammar.json', grammar);
  writeJson(`content/${contentFileName('sentences')}`, sentences);
  writeJson(`content/${contentFileName('stories')}`, stories, 'lines');
  writeJson(`content/${contentFileName('roleplays')}`, rolePlays);
  writeJson(`content/${contentFileName('units')}`, units);
  writeJson(`content/${contentFileName('mnemonics')}`, mnemonics);
  for (const file of RETIRED_OUTPUTS) rmSync(join(OUT, file), { force: true });

  printReport({ curriculum, words, core, links, grammar, units, rolePlays, sentences, dropped, stories, mnemonics, previous, built, conversations });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

interface ReportInput {
  curriculum: Curriculum;
  words: WordEntry[];
  core: CoreWord[];
  links: Map<string, string>;
  grammar: GrammarPoint[];
  units: UnitSpec[];
  rolePlays: RolePlay[];
  sentences: SentenceEntry[];
  dropped: number;
  stories: StoryEntry[];
  mnemonics: MnemonicsFile;
  previous: Map<string, string>;
  built: ReturnType<typeof buildCurriculum>;
  conversations: Map<string, number>;
}

function printReport(r: ReportInput): void {
  const { units } = r.curriculum;
  const wordInfo = new Map(r.words.map((w) => [`word:${w.id}`, `${w.written} ${w.kana}`]));
  for (const c of r.core) wordInfo.set(`core:${c.id}`, `${c.written ?? c.kana} ${c.kana}`);
  const shown = (ref: WordRef | null) => (ref ? (wordInfo.get(ref) ?? ref) : '—');

  console.log('\nCurriculum (v2)');
  console.log(`  ${units.length} kanji in ${units[units.length - 1]?.chapter ?? 0} chapters; first 40: ${units.slice(0, 40).map((u) => u.char).join('')}`);
  const wordless = units.filter((u) => u.anchor === null);
  console.log(`  kanji with no word: ${wordless.length} (e.g. ${wordless.slice(0, 20).map((u) => u.char).join('')})`);
  const taught = units.reduce((n, u) => n + (u.anchor ? 1 : 0) + u.staged.length, 0);
  const coreAnchors = units.filter((u) => u.anchor?.startsWith('core:')).length;
  console.log(`  words taught with kanji: ${taught} (mean ${(taught / units.length).toFixed(2)} per kanji, max ${MAX_UNIT_WORDS}); core-word anchors: ${coreAnchors}`);
  const rareParts = new Set([...r.built.parts.values()].flat().filter((p) => r.built.rare.has(p)));
  const namedParts = new Set([...r.built.parts.values()].flat());
  console.log(`  named parts: ${namedParts.size} (${rareParts.size} of them rare jōyō kanji, e.g. ${[...rareParts].slice(0, 12).join('')})`);
  console.log(`  inferable: ${units.filter((u) => u.inferable).length}; held back for confusables: ${r.built.spaced.join('') || 'none'}`);
  console.log(`  confusable sets: ${r.curriculum.confusables.length}`);
  const changes = units
    .slice(0, 300)
    .filter((u) => r.previous.size > 0 && (r.previous.get(u.char) ?? '—') !== shown(u.anchor))
    .slice(0, 20);
  if (changes.length > 0) {
    console.log('  anchor changes in the first 300 kanji (previous build → now):');
    for (const u of changes) console.log(`    #${u.index + 1} ${u.char}: ${r.previous.get(u.char) ?? '—'} → ${shown(u.anchor)}`);
  }

  console.log('\nContent');
  console.log(`  core words: ${r.core.length} (${r.links.size} JMdict entries are core words; ${r.core.filter((c) => c.use).length} with use)`);
  console.log(`  words.json: ${r.words.length} words (${r.words.filter((w) => w.use).length} spoken in role-plays or tasks)`);
  console.log(`  grammar: ${r.grammar.length} points; units: ${r.units.length}`);
  const canDos = r.units.flatMap((u) => u.canDos);
  console.log(`  can-dos ready: ${canDos.filter((c) => c.ready).length}/${canDos.length}; tasks ready: ${r.units.filter((u) => u.task.ready).length}/${r.units.length}`);
  console.log(`  role-plays: ${r.rolePlays.length} (${r.rolePlays.filter((p) => r.conversations.has(p.id)).length} core conversations)`);
  console.log(`  sentences: ${r.sentences.length}${r.dropped ? ` (${r.dropped} dropped)` : ''}; stories: ${r.stories.length}; mnemonics: ${Object.keys(r.mnemonics).length}`);

  console.log('\nOutput (public/data)');
  for (const o of outputs) console.log(`  ${o.file.padEnd(32)} ${kb(o.bytes).padStart(9)}   gzip ${kb(o.gzip).padStart(8)}`);
  for (const i of infos) console.log(`\ni ${i}`);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof BuildError) console.error(`\nbuild-data failed: ${err.message}`);
  else console.error(err);
  process.exitCode = 1;
});
