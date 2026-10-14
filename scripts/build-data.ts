// Builds the static study data in public/data/ from data-raw/ (KanjiVG,
// KANJIDIC2, JMdict) and the hand-authored files in content/.
//
//   node scripts/build-data.ts        (npm run build:data)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type {
  Curriculum,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  StrokesFile,
  WordEntry,
} from '../src/lib/types.ts';
import {
  CONTENT_KINDS,
  contentFileName,
  emptyContent,
  itemKanji,
  lateGrammarTags,
  mergeContent,
  type ContentItem,
  type ContentKind,
} from './lib/content.ts';
import { buildCurriculum } from './lib/curriculum.ts';
import { readJMdict } from './lib/jmdict.ts';
import { buildKanaTable, isStrokeKana } from './lib/kana.ts';
import { readKanjidic, type KanjidicEntry } from './lib/kanjidic.ts';
import {
  componentsOf,
  descendants,
  elementStrokes,
  ignoredElements,
  readKanjiVG,
  type KvgChar,
} from './lib/kanjivg.ts';
import { WORD_OVERRIDES } from './lib/word-overrides.ts';
import { selectWord } from './lib/words.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RAW = join(ROOT, 'data-raw');
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'public', 'data');

/** The raw dictionaries in data-raw/ and where to get them. */
const RAW_FILES = {
  kanjivg: ['kanjivg.xml.gz', 'https://github.com/KanjiVG/kanjivg/releases (kanjivg-YYYYMMDD.xml.gz)'],
  kanjidic: ['kanjidic2.xml.gz', 'http://www.edrdg.org/kanjidic/kanjidic2.xml.gz'],
  jmdict: ['JMdict_e.gz', 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz'],
} as const;

/** An ignored KanjiVG component used by this many jōyō kanji should be taught as a radical. */
const COMMON_COMPONENT_USERS = 20;

class BuildError extends Error {}

const warnings: string[] = [];
const warn = (message: string) => warnings.push(message);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new BuildError(`${relative(ROOT, path)} is not valid JSON: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// content/

interface LoadedContent {
  kind: ContentKind;
  /** Where it was authored, for messages: "content/grammar.json" or "content/sentences". */
  label: string;
  data: unknown;
  items: ContentItem[];
}

const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

/**
 * The files a content kind is authored in. Sentences are split by curriculum
 * band into content/sentences/*.json (merged in file-name order), and a
 * single content/sentences.json is still read after them.
 */
function contentFiles(kind: ContentKind): string[] {
  const files: string[] = [];
  const dir = join(CONTENT, kind);
  if (kind === 'sentences' && existsSync(dir)) {
    const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(naturalOrder);
    files.push(...names.map((f) => join(dir, f)));
  }
  const single = join(CONTENT, contentFileName(kind));
  if (existsSync(single)) files.push(single);
  return files;
}

/** Validates every content file up front so a typo fails fast, before the slow parsing. */
function loadContent(): LoadedContent[] {
  const errors: string[] = [];
  const loaded: LoadedContent[] = [];
  for (const kind of CONTENT_KINDS) {
    const files = contentFiles(kind);
    const label = kind === 'sentences' ? 'content/sentences' : `content/${contentFileName(kind)}`;
    if (files.length === 0) {
      warn(`${label} is missing; writing an empty placeholder`);
      loaded.push({ kind, label, data: emptyContent(kind), items: [] });
      continue;
    }
    const sources = files.map((path) => ({ file: relative(ROOT, path), data: readJson(path) }));
    const merged = mergeContent(kind, sources);
    errors.push(...merged.errors);
    for (const w of merged.warnings) warn(w);
    let data = merged.data;
    if (kind === 'grammar' && Array.isArray(data)) {
      data = [...data].sort((a, b) => (a as { order: number }).order - (b as { order: number }).order);
    }
    loaded.push({ kind, label, data, items: merged.items });
  }
  if (errors.length > 0) {
    throw new BuildError(`content has ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
  }
  return loaded;
}

/** Cross-file checks that need the curriculum: unknown kanji, mnemonics, grammar ids and phases. */
function crossCheckContent(content: LoadedContent[], curriculum: Curriculum): void {
  const taught = new Set(curriculum.units.map((u) => u.char));
  const grammar = content.find((c) => c.kind === 'grammar')?.data;
  const grammarPhase = new Map(
    (Array.isArray(grammar) ? (grammar as { id: string; phase: number }[]) : []).map((g) => [g.id, g.phase]),
  );
  for (const { kind, label: file, data, items } of content) {
    const unknown = new Map<string, string[]>();
    for (const item of items) {
      for (const ch of itemKanji(item)) {
        if (taught.has(ch)) continue;
        const list = unknown.get(ch) ?? [];
        list.push(item.id);
        unknown.set(ch, list);
      }
    }
    for (const [ch, ids] of unknown) {
      const what = kind === 'mnemonics' ? 'is not a curriculum kanji or radical' : 'is not taught by the curriculum';
      warn(`${file}: "${ch}" ${what} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})`);
    }
    if (kind === 'sentences' && Array.isArray(data)) {
      for (const s of data as { id?: string; grammar?: unknown }[]) {
        if (!Array.isArray(s.grammar)) continue;
        for (const g of s.grammar) if (!grammarPhase.has(g)) warn(`${file}: ${s.id} refers to unknown grammar "${g}"`);
      }
      for (const late of lateGrammarTags(data, curriculum.units, grammarPhase)) {
        warn(
          `${file}: ${late.id} unlocks in phase ${late.unlockPhase} but uses "${late.grammar}" from phase ${late.grammarPhase}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// content/radicals.json

function loadRadicals(kvg: Map<string, KvgChar>, kanjidic: Map<string, KanjidicEntry>): RadicalEntry[] {
  const path = join(CONTENT, 'radicals.json');
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
    if (kanjidic.has(r.char)) errors.push(`${where}: is a jōyō kanji, so it is taught as a kanji unit`);
    if (!elements.has(r.char)) errors.push(`${where}: KanjiVG never uses it as an element`);
    if (r.variantOf !== undefined && !kanjidic.has(r.variantOf)) warn(`${where}: variantOf "${r.variantOf}" is not a jōyō kanji`);
    seen.add(r.char);
    const entry: RadicalEntry = { char: r.char, name: r.name!, meaning: r.meaning! };
    if (r.variantOf) entry.variantOf = r.variantOf;
    radicals.push(entry);
  }
  if (errors.length > 0) throw new BuildError(`content/radicals.json has errors:\n  ${errors.join('\n  ')}`);
  return radicals;
}

// ---------------------------------------------------------------------------
// Output

const outputs: { file: string; bytes: number; gzip: number }[] = [];

function writeJson(file: string, data: unknown): void {
  const path = join(OUT, file);
  mkdirSync(join(path, '..'), { recursive: true });
  const json = JSON.stringify(data) + '\n';
  writeFileSync(path, json);
  const bytes = Buffer.byteLength(json);
  outputs.push({ file, bytes, gzip: gzipSync(json).length });
}

const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;

function printReport(curriculum: Curriculum, words: WordEntry[]): void {
  const { units, phaseEnds } = curriculum;
  console.log('\nCurriculum');
  let start = 0;
  for (const phase of ['2', '3', '4']) {
    const slice = units.slice(start, phaseEnds[phase]);
    const kanji = slice.filter((u) => u.type === 'kanji').length;
    console.log(`  phase ${phase}: units ${start}–${phaseEnds[phase] - 1}  ${kanji} kanji, ${slice.length - kanji} radicals`);
    start = phaseEnds[phase];
  }
  console.log(`  first 40: ${units.slice(0, 40).map((u) => (u.type === 'radical' ? `[${u.char}]` : u.char)).join(' ')}`);
  const wordless = units.filter((u) => u.type === 'kanji' && u.words.length === 0);
  console.log(`  kanji with 0 words: ${wordless.length} (e.g. ${wordless.slice(0, 20).map((u) => u.char).join('')})`);
  const used = units.reduce((n, u) => n + u.words.length, 0);
  console.log(`  words used by units: ${used} of ${words.length}`);

  console.log('\nOutput (public/data)');
  for (const o of outputs) console.log(`  ${o.file.padEnd(28)} ${kb(o.bytes).padStart(9)}   gzip ${kb(o.gzip).padStart(8)}`);
}

// ---------------------------------------------------------------------------

function rawPath(key: keyof typeof RAW_FILES): string {
  const [file, source] = RAW_FILES[key];
  const path = join(RAW, file);
  if (!existsSync(path)) throw new BuildError(`data-raw/${file} is missing. Download it from ${source}`);
  return path;
}

async function main(): Promise<void> {
  const started = Date.now();
  const paths = { kanjivg: rawPath('kanjivg'), kanjidic: rawPath('kanjidic'), jmdict: rawPath('jmdict') };
  const content = loadContent();

  const [kvg, kanjidic] = await Promise.all([readKanjiVG(paths.kanjivg), readKanjidic(paths.kanjidic)]);
  console.log(`KanjiVG: ${kvg.size} characters; KANJIDIC2: ${kanjidic.size} jōyō kanji`);
  const radicals = loadRadicals(kvg, kanjidic);
  const radicalChars = new Set(radicals.map((r) => r.char));

  const isJoyo = (ch: string) => kanjidic.has(ch);
  const words: WordEntry[] = [];
  const coreWords = new Set<string>();
  let entries = 0;
  await readJMdict(paths.jmdict, (e) => {
    entries++;
    const selected = selectWord(e, isJoyo);
    if (!selected) return;
    words.push(selected.word);
    if (selected.core) coreWords.add(selected.word.id);
  });
  words.sort((a, b) => Number(a.id) - Number(b.id));
  console.log(`JMdict: ${entries} entries → ${words.length} common words`);

  const isTeachable = (el: string) => kanjidic.has(el) || radicalChars.has(el);
  const components = new Map<string, string[]>();
  const ignoredBy = new Map<string, Set<string>>();
  for (const k of kanjidic.keys()) {
    const glyph = kvg.get(k);
    if (!glyph) {
      warn(`KanjiVG has no entry for jōyō kanji ${k}; it gets no components or strokes`);
      continue;
    }
    components.set(k, componentsOf(glyph, isTeachable));
    // Lone strokes (丿 丶 丨) are KanjiVG elements too, but not components worth a unit.
    for (const g of ignoredElements(glyph, isTeachable)) {
      if (g.strokes.length < 2) continue;
      let users = ignoredBy.get(g.element!);
      if (!users) ignoredBy.set(g.element!, (users = new Set()));
      users.add(k);
    }
  }
  for (const [el, users] of ignoredBy) {
    if (users.size < COMMON_COMPONENT_USERS) continue;
    const some = [...users].slice(0, 8).join('');
    warn(`component ${el} is used by ${users.size} jōyō kanji (${some}…) but is not in content/radicals.json`);
  }

  const curriculum = buildCurriculum({
    kanji: [...kanjidic.values()],
    components,
    radicals: radicalChars,
    words,
    coreWords,
    overrides: WORD_OVERRIDES,
    warn,
  });
  const unitIndex = new Map(curriculum.units.map((u) => [u.char, u.index]));

  const kanjiOut: Record<string, KanjiEntry> = {};
  let strokeCountFixes = 0;
  for (const u of curriculum.units) {
    if (u.type !== 'kanji') continue;
    const k = kanjidic.get(u.char)!;
    const drawn = kvg.get(u.char)?.strokes.length;
    if (drawn !== undefined && drawn !== k.strokeCount) strokeCountFixes++;
    kanjiOut[u.char] = {
      char: k.char,
      meanings: k.meanings,
      on: k.on,
      kun: k.kun,
      // Match the strokes the writing pad draws when the dictionaries disagree.
      strokeCount: drawn ?? k.strokeCount,
      grade: k.grade,
      jlptOld: k.jlptOld,
      freq: k.freq,
      components: (components.get(u.char) ?? []).filter((c) => (unitIndex.get(c) ?? Infinity) < u.index),
    };
  }
  if (strokeCountFixes > 0) console.log(`Stroke counts taken from KanjiVG where KANJIDIC2 differs: ${strokeCountFixes} kanji`);

  const usedRadicals = radicals.filter((r) => unitIndex.has(r.char));
  for (const r of radicals) if (!unitIndex.has(r.char)) warn(`radical ${r.char} (${r.name}) is never used by a curriculum kanji`);

  const strokes: StrokesFile = {};
  for (const [ch, glyph] of kvg) if (isStrokeKana(ch)) strokes[ch] = glyph.strokes;
  for (const u of curriculum.units) {
    let paths = kvg.get(u.char)?.strokes;
    if (!paths && u.type === 'radical') {
      // No KanjiVG entry of its own: take it from the first kanji that uses it.
      const host = curriculum.units.find((h) => h.type === 'kanji' && kanjiOut[h.char].components.includes(u.char));
      const hostGlyph = host && kvg.get(host.char);
      paths = hostGlyph ? elementStrokes(hostGlyph, u.char) : undefined;
    }
    if (paths && paths.length > 0) strokes[u.char] = paths;
    else warn(`no stroke data for ${u.type} ${u.char}`);
  }

  crossCheckContent(content, curriculum);

  const kana: KanaEntry[] = buildKanaTable();
  for (const k of kana) if ([...k.char].length === 1 && !strokes[k.char]) warn(`no stroke data for kana ${k.char}`);

  writeJson('kana.json', kana);
  writeJson('kanji.json', kanjiOut);
  writeJson('radicals.json', usedRadicals);
  writeJson('words.json', words);
  writeJson('curriculum.json', curriculum);
  writeJson('strokes.json', strokes);
  for (const { kind, data } of content) writeJson(`content/${contentFileName(kind)}`, data);

  printReport(curriculum, words);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err: unknown) => {
  if (err instanceof BuildError) console.error(`\nbuild-data failed: ${err.message}`);
  else console.error(err);
  process.exitCode = 1;
});
