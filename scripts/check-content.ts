// Checks one hand-authored content file against the built curriculum.
//
//   node scripts/check-content.ts <file.json> [--max-unit N] [--kind KIND]
//
// Prints ruby/structure errors, each entry's "unlock index" (the highest
// curriculum unit among its kanji: the entry is readable once that unit is
// learned), kanji the curriculum never teaches, ruby readings that are not
// among JMdict's readings for that spelling (words.json when data-raw/ is
// absent), sentence grammar tags taught in a later phase than the sentence
// unlocks, and with --max-unit the entries that unlock too late.
// Exits 1 when the file has validation errors, 2 on bad usage or missing data.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Curriculum, WordEntry } from '../src/lib/types.ts';
import {
  CONTENT_KINDS,
  checkContent,
  detectContentKind,
  lateGrammarTags,
  readingMismatches,
  unlockOf,
  type ContentKind,
} from './lib/content.ts';
import { readJmdictReadings } from './lib/readings.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'public', 'data');
const JMDICT = join(ROOT, 'data-raw', 'JMdict_e.gz');

const USAGE = `Usage: node scripts/check-content.ts <file.json> [--max-unit N] [--kind ${CONTENT_KINDS.join('|')}]`;

interface Args {
  file: string;
  maxUnit?: number;
  kind?: ContentKind;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let file: string | undefined;
  let maxUnit: number | undefined;
  let kind: ContentKind | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-unit') {
      maxUnit = Number(argv[++i]);
      if (!Number.isInteger(maxUnit) || maxUnit < 0) fail(`--max-unit needs a unit index\n${USAGE}`);
    } else if (arg === '--kind') {
      kind = argv[++i] as ContentKind;
      if (!CONTENT_KINDS.includes(kind)) fail(`unknown --kind "${kind}"\n${USAGE}`);
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (!file && !arg.startsWith('--')) {
      file = arg;
    } else {
      fail(`unexpected argument "${arg}"\n${USAGE}`);
    }
  }
  if (!file) fail(USAGE);
  return { file, maxUnit, kind };
}

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    return fail(`could not read ${what} (${path}): ${(err as Error).message}`);
  }
}

interface Readings {
  source: string;
  byWritten: Map<string, string[]>;
  /** Spellings of the words okurigana can complete (see readingMismatches). */
  words: Set<string>;
}

/**
 * Readings to compare ruby against: every JMdict reading of the spelling, so
 * that valid readings words.json does not keep (明日 みょうにち, 家 うち) pass.
 */
async function loadReadings(): Promise<Readings> {
  const byWritten = new Map<string, string[]>();
  for (const w of readJson<WordEntry[]>(join(DATA, 'words.json'), 'words.json')) {
    byWritten.set(w.written, [...(byWritten.get(w.written) ?? []), w.kana]);
  }
  const words = new Set(byWritten.keys());
  if (!existsSync(JMDICT)) {
    console.log('(data-raw/JMdict_e.gz is missing: checking readings against words.json only)\n');
    return { source: 'words.json', byWritten, words };
  }
  for (const [written, kana] of (await readJmdictReadings(JMDICT)).byWritten) {
    byWritten.set(written, [...new Set([...(byWritten.get(written) ?? []), ...kana])]);
  }
  return { source: 'JMdict', byWritten, words };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.file);
  if (!existsSync(path)) fail(`no such file: ${args.file}`);
  if (!existsSync(join(DATA, 'curriculum.json'))) fail('public/data is missing: run `npm run build:data` first');

  const data = readJson<unknown>(path, 'the content file');
  const kind = args.kind ?? detectContentKind(path, data);
  if (!kind) fail(`cannot tell what kind of content ${args.file} is; pass --kind\n${USAGE}`);

  const curriculum = readJson<Curriculum>(join(DATA, 'curriculum.json'), 'curriculum.json');
  const unitIndex = new Map(curriculum.units.map((u) => [u.char, u.index]));
  const phaseOf = (index: number) => curriculum.units[index]?.phase;
  const readings = await loadReadings();

  const report = checkContent(kind, data);
  const rel = relative(process.cwd(), path);
  const label = rel && !rel.startsWith('..') ? rel : path;
  console.log(`${label}: ${kind}, ${report.items.length} entries`);

  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length})`);
    for (const e of report.errors) console.log(`  ✗ ${e}`);
  }
  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length})`);
    for (const w of report.warnings) console.log(`  ! ${w}`);
  }

  const flags: string[] = [];
  const notTaught = new Map<string, string[]>();
  const width = Math.max(0, ...report.items.map((i) => i.where.length));
  console.log('\nUnlock index (highest curriculum unit among the kanji)');
  for (const item of report.items) {
    const unlock = unlockOf(item, unitIndex);
    let line = `  ${item.where.padEnd(width)}  `;
    if (unlock.index >= 0) line += `${String(unlock.index).padStart(4)}  ${unlock.char}  phase ${phaseOf(unlock.index)}`;
    else line += unlock.missing.length > 0 ? '   —' : 'kana only';
    if (args.maxUnit !== undefined && unlock.index > args.maxUnit) {
      line += `   > max ${args.maxUnit}`;
      flags.push(`${item.where} unlocks at unit ${unlock.index} (${unlock.char}), after --max-unit ${args.maxUnit}`);
    }
    if (unlock.missing.length > 0) line += `   not taught: ${unlock.missing.join('')}`;
    console.log(line);
    for (const ch of unlock.missing) notTaught.set(ch, [...(notTaught.get(ch) ?? []), item.id]);
    for (const m of readingMismatches(item, readings.byWritten, readings.words)) {
      flags.push(`${m.path}: ${m.written} read as ${m.reading}, ${readings.source} has ${m.expected.join(' / ')}`);
    }
  }
  for (const [ch, ids] of notTaught) {
    flags.push(`${ch} is not taught by the curriculum (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''})`);
  }
  if (kind === 'sentences') flags.push(...grammarFlags(data, curriculum));

  if (flags.length > 0) {
    console.log(`\nFlagged (${flags.length})`);
    for (const f of flags) console.log(`  ! ${f}`);
  }
  console.log(`\n${report.items.length} entries, ${report.errors.length} errors, ${report.warnings.length} warnings, ${flags.length} flagged`);
  if (report.errors.length > 0) process.exitCode = 1;
}

/** Grammar tags that content/grammar.json does not define, or teaches after the sentence unlocks. */
function grammarFlags(sentences: unknown, curriculum: Curriculum): string[] {
  const grammarPath = join(ROOT, 'content', 'grammar.json');
  if (!existsSync(grammarPath)) return [];
  const grammar = readJson<{ id: string; phase: number }[]>(grammarPath, 'content/grammar.json');
  const phases = new Map(grammar.map((g) => [g.id, g.phase]));
  const flags: string[] = [];
  for (const s of Array.isArray(sentences) ? (sentences as { id?: string; grammar?: unknown }[]) : []) {
    if (!Array.isArray(s.grammar)) continue;
    for (const g of s.grammar) if (!phases.has(g)) flags.push(`${s.id} refers to unknown grammar "${g}"`);
  }
  for (const late of lateGrammarTags(sentences, curriculum.units, phases)) {
    flags.push(`${late.id} unlocks in phase ${late.unlockPhase} but uses "${late.grammar}" from phase ${late.grammarPhase}`);
  }
  return flags;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 2;
});
