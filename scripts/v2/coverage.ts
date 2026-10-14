// Vocabulary coverage and validation for v2 content.
//
//   node scripts/v2/coverage.ts <file.json|dir> [--ceiling N] [--grammar-max ORDER]
//                                [--fails] [--json] [--count-names]
//
// Understands content/stories/*.json (StoryEntry, or an array of them), content/units.json and
// content/units/*.json (UnitSpec: the task's scripted lines and each can-do's material),
// content/roleplays-v2.json (and the old roleplays.json), content/grammar-v2.json (each point's
// examples) and any array of { jp } (content/sentences/*.json). A directory is searched for
// .json files; files of other kinds are skipped.
//
// For each item it prints the number of content tokens, the share covered by core words with
// order ≤ the ceiling (✓ at 98 % or more, else ✗), the highest core word used, the uncovered
// lemmas (#order = core word past the ceiling, jm = JMdict word not in the core list, ? = not
// found), names left out of the count, and ruby problems (src/lib/ruby.ts validateRuby). For
// stories it also checks the character count against the level, the gist question, and that
// every grammar id exists and is taught by the grammar maximum.
//
// The ceiling is --ceiling, else the item's unit's coreWordCeiling (content/units.json or
// content/units/*.json), else every core word. The grammar maximum is --grammar-max, else the
// order of the unit's last grammar point, else unchecked.
//
// --fails        print only items under 98 % or with problems
// --json         print a JSON report instead of text
// --count-names  count names (people, places) as content tokens instead of leaving them out
//
// Exits 1 on validation errors (ruby, story structure and length, unknown or too-late grammar
// ids, unknown targets), 2 on bad usage. Coverage under 98 % is flagged ✗ but is not an error.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRuby } from '../../src/lib/ruby.ts';
import type { RubyText } from '../../src/lib/types.ts';
import { getTokenizer, plainText, type RubyToken, type RubyTokenizer } from './tokenize.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTENT = join(ROOT, 'content');

export const COVERAGE_TARGET = 0.98;

/** Character counts (ruby, phrase marks and spaces removed) and word limits per story level. */
export const STORY_LIMITS: Record<string, { min: number; max: number; maxWords?: number }> = {
  start: { min: 100, max: 300, maxWords: 200 },
  L0: { min: 200, max: 400 },
  L1: { min: 400, max: 1200 },
};

// ---------------------------------------------------------------------------------------------
// Content shapes (see CONTENT-SCHEMAS.md); only the fields this tool reads.

interface Line {
  jp: RubyText;
  en?: string;
}

interface StoryEntry {
  id: string;
  level: string;
  unit: number;
  title?: string;
  titleJp?: RubyText;
  topic?: string;
  grammar: string[];
  sentences: Line[];
  gist: { q: string; options: string[]; answer: number };
}

interface UnitSpec {
  id: number;
  titleJp?: RubyText;
  grammar: string[];
  coreWordCeiling: number;
  canDos?: { id: string; check?: { kind?: string; material?: RubyText } }[];
  conversation?: string;
  task?: { id?: string; targets?: string[]; scripted?: Line[] };
  capstone?: { structures?: string[] };
}

interface RolePlay {
  id: string;
  unit?: number;
  titleJp?: RubyText;
  targets?: string[];
  roles?: { a?: { nameJp?: RubyText }; b?: { nameJp?: RubyText } };
  lines: Line[];
}

interface GrammarPoint {
  id: string;
  order: number;
  pattern?: RubyText;
  examples: Line[];
  buildItems?: { jp: RubyText }[];
  drills?: { prompt: RubyText }[];
}

export type ContentKind = 'story' | 'unit' | 'roleplay' | 'grammar' | 'jp-list';

// ---------------------------------------------------------------------------------------------
// Context: grammar orders, units, conversations

export interface Context {
  tk: RubyTokenizer;
  grammarOrder: Map<string, number>;
  units: Map<number, UnitSpec>;
  conversations: Set<string> | null;
  maxCoreOrder: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function unitsFrom(data: unknown): UnitSpec[] {
  const list = Array.isArray(data) ? data : [data];
  return list.filter((u): u is UnitSpec => !!u && typeof u === 'object' && typeof (u as UnitSpec).id === 'number' && 'coreWordCeiling' in u);
}

export async function loadContext(): Promise<Context> {
  const tk = await getTokenizer();
  const grammarOrder = new Map<string, number>();
  const gPath = join(CONTENT, 'grammar-v2.json');
  if (existsSync(gPath)) for (const g of readJson(gPath) as GrammarPoint[]) grammarOrder.set(g.id, g.order);
  const units = new Map<number, UnitSpec>();
  const uFile = join(CONTENT, 'units.json');
  if (existsSync(uFile)) for (const u of unitsFrom(readJson(uFile))) units.set(u.id, u);
  const uDir = join(CONTENT, 'units');
  if (existsSync(uDir)) {
    for (const f of readdirSync(uDir).filter((n) => n.endsWith('.json')).sort()) {
      for (const u of unitsFrom(readJson(join(uDir, f)))) units.set(u.id, u);
    }
  }
  const rPath = join(CONTENT, 'roleplays-v2.json');
  const conversations = existsSync(rPath) ? new Set((readJson(rPath) as RolePlay[]).map((r) => r.id)) : null;
  let maxCoreOrder = 0;
  for (const w of tk.core.values()) maxCoreOrder = Math.max(maxCoreOrder, w.order);
  return { tk, grammarOrder, units, conversations, maxCoreOrder };
}

// ---------------------------------------------------------------------------------------------
// Coverage

export interface Uncovered {
  lemma: string;
  /** '#612' core word past the ceiling, 'jm' JMdict word, '?' not found. */
  why: string;
  count: number;
}

export interface Coverage {
  content: number;
  covered: number;
  /** covered / content (1 when there are no content tokens). */
  ratio: number;
  /** Highest core-word order among the content tokens (0 when none). */
  maxOrder: number;
  uncovered: Uncovered[];
  names: string[];
  /** Distinct content words (core id, JMdict id or lemma). */
  distinct: number;
}

/** Marks tokens that spell one of `names` (role names such as もり or たなか) as proper. */
function markNames(tokens: RubyToken[], names: string[]): void {
  if (!names.length) return;
  for (let i = 0; i < tokens.length; i++) {
    let s = '';
    for (let j = i; j < tokens.length && s.length < 12; j++) {
      s += tokens[j].surface;
      if (names.includes(s)) {
        for (let k = i; k <= j; k++) if (tokens[k].kind === 'content') tokens[k].proper = true;
        break;
      }
    }
  }
}

export function coverageOf(
  tokens: RubyToken[],
  tk: RubyTokenizer,
  ceiling: number,
  countNames = false,
): Coverage {
  let content = 0;
  let covered = 0;
  let maxOrder = 0;
  const missing = new Map<string, Uncovered>();
  const names = new Set<string>();
  const distinct = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== 'content') continue;
    if (t.proper && !countNames) {
      names.add(t.surface);
      continue;
    }
    content++;
    distinct.add(t.ref ?? t.lemma);
    const core = t.ref?.startsWith('core:') ? tk.core.get(t.ref.slice(5)) : undefined;
    if (core) maxOrder = Math.max(maxOrder, core.order);
    if (core && core.order <= ceiling) {
      covered++;
      continue;
    }
    const why = core ? `#${core.order}` : t.ref ? 'jm' : '?';
    const key = `${t.lemma}\u0000${why}`;
    const entry = missing.get(key) ?? { lemma: t.lemma, why, count: 0 };
    entry.count++;
    missing.set(key, entry);
  }
  return {
    content,
    covered,
    ratio: content ? covered / content : 1,
    maxOrder,
    uncovered: [...missing.values()].sort((a, b) => b.count - a.count),
    names: [...names],
    distinct: distinct.size,
  };
}

// ---------------------------------------------------------------------------------------------
// Items

interface Field {
  field: string;
  jp: RubyText;
}

export interface Item {
  label: string;
  /** Texts whose words are counted. */
  texts: Field[];
  /** Further ruby fields that are only validated (titles, names, patterns, drills). */
  rubyOnly: Field[];
  unit?: number;
  names?: string[];
  story?: StoryEntry;
  /** Grammar ids that must exist and be taught by the grammar maximum. */
  grammar?: { field: string; ids: string[] };
  /** Grammar ids that must exist (any order). */
  grammarExists?: { field: string; ids: string[] };
  targets?: string[];
  conversation?: string;
}

export interface ItemReport {
  label: string;
  ceiling: number;
  ceilingFrom: string;
  grammarMax?: number;
  coverage: Coverage;
  chars?: number;
  errors: string[];
  warnings: string[];
  notes: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function kindOf(x: unknown): ContentKind | undefined {
  if (!isObj(x)) return undefined;
  if (Array.isArray(x.sentences) && 'level' in x && 'gist' in x) return 'story';
  if ('coreWordCeiling' in x || Array.isArray(x.canDos)) return 'unit';
  if (Array.isArray(x.lines)) return 'roleplay';
  if (Array.isArray(x.examples) && 'order' in x) return 'grammar';
  if (typeof x.jp === 'string') return 'jp-list';
  return undefined;
}

/** The content kind of a parsed JSON file, or undefined when it holds something else. */
export function detectKind(data: unknown): ContentKind | undefined {
  if (Array.isArray(data)) {
    if (!data.length) return undefined;
    const k = kindOf(data[0]);
    return k && data.every((x) => kindOf(x) === k) ? k : undefined;
  }
  const k = kindOf(data);
  return k === 'jp-list' ? undefined : k;
}

const plainName = (s: RubyText | undefined) => (s ? plainText(s) : '');

export function itemsOf(kind: ContentKind, data: unknown): Item[] {
  const list = (Array.isArray(data) ? data : [data]) as never[];
  switch (kind) {
    case 'story':
      return (list as StoryEntry[]).map((s) => ({
        label: s.id ?? '(no id)',
        texts: (s.sentences ?? []).map((l, i) => ({ field: `sentences[${i}]`, jp: l?.jp ?? '' })),
        rubyOnly: s.titleJp ? [{ field: 'titleJp', jp: s.titleJp }] : [],
        unit: s.unit,
        story: s,
        grammar: { field: 'grammar', ids: s.grammar ?? [] },
      }));
    case 'unit':
      return (list as UnitSpec[]).flatMap((u) => {
        const tag = `u${String(u.id).padStart(2, '0')}`;
        const items: Item[] = [
          {
            label: `${tag} task${u.task?.id ? ` ${u.task.id}` : ''}`,
            texts: (u.task?.scripted ?? []).map((l, i) => ({ field: `task.scripted[${i}]`, jp: l?.jp ?? '' })),
            rubyOnly: u.titleJp ? [{ field: 'titleJp', jp: u.titleJp }] : [],
            unit: u.id,
            grammarExists: { field: 'grammar', ids: u.grammar ?? [] },
            grammar: { field: 'capstone.structures', ids: u.capstone?.structures ?? [] },
            targets: u.task?.targets ?? [],
            conversation: u.conversation,
          },
        ];
        for (const cd of u.canDos ?? []) {
          items.push({
            label: `${cd.id ?? tag} ${cd.check?.kind ?? 'check'} material`,
            texts: cd.check?.material ? [{ field: 'check.material', jp: cd.check.material }] : [],
            rubyOnly: [],
            unit: u.id,
          });
        }
        return items;
      });
    case 'roleplay':
      return (list as RolePlay[]).map((r) => ({
        label: r.id ?? '(no id)',
        texts: (r.lines ?? []).map((l, i) => ({ field: `lines[${i}]`, jp: l?.jp ?? '' })),
        rubyOnly: [
          ...(r.titleJp ? [{ field: 'titleJp', jp: r.titleJp }] : []),
          ...(['a', 'b'] as const).flatMap((k) => {
            const nameJp = r.roles?.[k]?.nameJp;
            return nameJp ? [{ field: `roles.${k}.nameJp`, jp: nameJp }] : [];
          }),
        ],
        unit: r.unit,
        names: [plainName(r.roles?.a?.nameJp), plainName(r.roles?.b?.nameJp)].filter(Boolean),
        targets: r.targets,
      }));
    case 'grammar':
      return (list as GrammarPoint[]).map((g) => ({
        label: `${String(g.order).padStart(3)} ${g.id}`,
        texts: g.examples.map((e, i) => ({ field: `examples[${i}]`, jp: e.jp })),
        rubyOnly: [
          ...(g.pattern ? [{ field: 'pattern', jp: g.pattern }] : []),
          ...(g.buildItems ?? []).map((b, i) => ({ field: `buildItems[${i}].jp`, jp: b.jp })),
          ...(g.drills ?? []).map((d, i) => ({ field: `drills[${i}].prompt`, jp: d.prompt })),
        ],
      }));
    case 'jp-list':
      return (list as (Line & { id?: string })[]).map((l, i) => ({
        label: l.id ?? `#${i + 1}`,
        texts: [{ field: 'jp', jp: l.jp }],
        rubyOnly: [],
      }));
  }
}

// ---------------------------------------------------------------------------------------------
// Checks

export interface Options {
  ceiling?: number;
  grammarMax?: number;
  countNames?: boolean;
}

function checkStory(s: StoryEntry, chars: number, distinct: number, report: ItemReport): void {
  const { errors, warnings, notes } = report;
  if (typeof s.id !== 'string' || !s.id) errors.push('story: missing id');
  const limits = STORY_LIMITS[s.level];
  if (!limits) {
    errors.push(`story: level "${s.level}" is not one of ${Object.keys(STORY_LIMITS).join(', ')}`);
  } else {
    const ok = chars >= limits.min && chars <= limits.max;
    const line = `chars ${chars} (${s.level} ${limits.min}–${limits.max})`;
    if (ok) notes.push(`${line} ✓`);
    else errors.push(`${line}: out of range`);
    if (limits.maxWords !== undefined) {
      if (distinct > limits.maxWords) errors.push(`distinct words ${distinct}: over the ${s.level} limit of ${limits.maxWords}`);
      else notes.push(`distinct words ${distinct} (≤ ${limits.maxWords}) ✓`);
    }
  }
  if (typeof s.unit !== 'number') errors.push('story: unit must be a number');
  if (!Array.isArray(s.sentences) || !s.sentences.length) errors.push('story: no sentences');
  (s.sentences ?? []).forEach((l, i) => {
    if (typeof l?.jp !== 'string' || !l.jp.trim()) errors.push(`sentences[${i}]: missing jp`);
    if (typeof l?.en !== 'string' || !l.en.trim()) errors.push(`sentences[${i}]: missing en`);
    if (typeof l?.jp === 'string' && /(^\s*／)|(／\s*／)|(／\s*$)/u.test(l.jp)) warnings.push(`sentences[${i}]: empty phrase between ／ marks`);
  });
  if (!(s.sentences ?? []).some((l) => l?.jp?.includes('／'))) warnings.push('no ／ phrase marks (needed for read-while-listening)');
  const g = s.gist;
  if (!g || typeof g.q !== 'string' || !Array.isArray(g.options) || g.options.length !== 3) {
    errors.push('gist: needs a question and exactly 3 options');
  } else if (!Number.isInteger(g.answer) || g.answer < 0 || g.answer >= g.options.length) {
    errors.push(`gist: answer ${g.answer} is not an option index`);
  }
}

function checkGrammarIds(field: string, ids: string[], ctx: Context, max: number | undefined, errors: string[]): void {
  for (const id of ids) {
    const order = ctx.grammarOrder.get(id);
    if (order === undefined) errors.push(`${field}: unknown grammar id "${id}"`);
    else if (max !== undefined && order > max) errors.push(`${field}: "${id}" is grammar #${order}, after the maximum #${max}`);
  }
}

function checkTargets(targets: string[], ctx: Context, grammarMax: number | undefined, errors: string[]): void {
  for (const t of targets) {
    const [kind, id] = t.split(':');
    if (kind === 'core') {
      if (!ctx.tk.core.has(id)) errors.push(`targets: unknown core word "${t}"`);
    } else if (kind === 'grammar') {
      checkGrammarIds('targets', [id], ctx, grammarMax, errors);
    } else {
      errors.push(`targets: "${t}" is not core:… or grammar:…`);
    }
  }
}

export function analyzeItem(item: Item, ctx: Context, opts: Options = {}): ItemReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const unit = item.unit !== undefined ? ctx.units.get(item.unit) : undefined;
  if (item.unit !== undefined && !unit) warnings.push(`unit ${item.unit} is not in content/units.json or content/units/`);

  let ceiling = ctx.maxCoreOrder;
  let ceilingFrom = 'all core words';
  if (opts.ceiling !== undefined) {
    ceiling = opts.ceiling;
    ceilingFrom = '--ceiling';
  } else if (unit) {
    ceiling = unit.coreWordCeiling;
    ceilingFrom = `unit ${unit.id}`;
  }

  let grammarMax = opts.grammarMax;
  if (grammarMax === undefined && unit) {
    const orders = (unit.grammar ?? []).map((id) => ctx.grammarOrder.get(id)).filter((o): o is number => o !== undefined);
    if (orders.length) grammarMax = Math.max(...orders);
  }

  for (const f of [...item.texts, ...item.rubyOnly]) {
    if (typeof f.jp !== 'string') {
      errors.push(`${f.field}: not a string`);
      continue;
    }
    for (const p of validateRuby(f.jp)) errors.push(`ruby ${f.field}: ${p}`);
  }

  const tokens = item.texts.flatMap((f) => (typeof f.jp === 'string' ? ctx.tk.tokenize(f.jp) : []));
  markNames(tokens, item.names ?? []);
  const coverage = coverageOf(tokens, ctx.tk, ceiling, opts.countNames);
  const report: ItemReport = { label: item.label, ceiling, ceilingFrom, grammarMax, coverage, errors, warnings, notes };

  if (item.story) {
    const chars = item.texts.reduce((n, f) => n + (typeof f.jp === 'string' ? plainText(f.jp).length : 0), 0);
    report.chars = chars;
    checkStory(item.story, chars, coverage.distinct, report);
  }
  if (item.grammar) {
    checkGrammarIds(item.grammar.field, item.grammar.ids, ctx, grammarMax, errors);
    if (grammarMax === undefined && item.story) notes.push('grammar maximum unknown (no unit, no --grammar-max): ids checked for existence only');
  }
  if (item.grammarExists) checkGrammarIds(item.grammarExists.field, item.grammarExists.ids, ctx, undefined, errors);
  if (item.targets) checkTargets(item.targets, ctx, grammarMax, errors);
  if (item.conversation && ctx.conversations && !ctx.conversations.has(item.conversation)) {
    warnings.push(`conversation "${item.conversation}" is not in content/roleplays-v2.json`);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Files

export interface FileReport {
  file: string;
  kind?: ContentKind;
  skipped?: string;
  items: ItemReport[];
}

export function analyzeFile(path: string, ctx: Context, opts: Options = {}): FileReport {
  const file = relative(process.cwd(), path) || path;
  let data: unknown;
  try {
    data = readJson(path);
  } catch (e) {
    return { file, items: [{ ...emptyReport(basename(path)), errors: [`invalid JSON: ${(e as Error).message}`] }] };
  }
  const kind = detectKind(data);
  if (!kind) return { file, skipped: 'not a story, unit, role-play, grammar or { jp } file', items: [] };
  return { file, kind, items: itemsOf(kind, data).map((item) => analyzeItem(item, ctx, opts)) };
}

function emptyReport(label: string): ItemReport {
  return {
    label,
    ceiling: 0,
    ceilingFrom: '',
    coverage: { content: 0, covered: 0, ratio: 1, maxOrder: 0, uncovered: [], names: [], distinct: 0 },
    errors: [],
    warnings: [],
    notes: [],
  };
}

function jsonFiles(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  const out: string[] = [];
  for (const name of readdirSync(target).sort()) {
    const p = join(target, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text output

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

function uncoveredText(list: Uncovered[], limit = 12): string {
  const parts = list.slice(0, limit).map((u) => `${u.lemma} ${u.why}${u.count > 1 ? ` ×${u.count}` : ''}`);
  if (list.length > limit) parts.push(`… ${list.length - limit} more`);
  return parts.join(' · ');
}

function printFile(fr: FileReport, failsOnly: boolean): void {
  if (fr.skipped) {
    console.log(`── ${fr.file}: skipped (${fr.skipped})`);
    return;
  }
  const ceilings = new Set(fr.items.map((r) => `${r.ceilingFrom}${r.ceilingFrom.startsWith('unit') ? '' : ` (${r.ceiling})`}`));
  const ceilingNote = ceilings.size === 1 ? `ceiling: ${[...ceilings][0]}` : 'ceiling: per unit';
  console.log(`── ${fr.file} · ${fr.kind} · ${fr.items.length} item${fr.items.length === 1 ? '' : 's'} · ${ceilingNote}`);
  for (const r of fr.items) {
    const c = r.coverage;
    const ok = c.ratio >= COVERAGE_TARGET;
    const problems = r.errors.length + r.warnings.length;
    if (failsOnly && ok && !problems) continue;
    const unitNote = r.ceilingFrom.startsWith('unit') ? `  [${r.ceilingFrom}: ≤ #${r.ceiling}${r.grammarMax ? `, grammar ≤ #${r.grammarMax}` : ''}]` : '';
    console.log(
      `${ok ? '✓' : '✗'} ${pct(c.ratio).padStart(6)} ${String(c.content).padStart(4)} tok  max #${String(c.maxOrder).padEnd(5)} ${r.label}${unitNote}`,
    );
    if (c.uncovered.length) console.log(`      uncovered: ${uncoveredText(c.uncovered)}`);
    if (c.names.length) console.log(`      names (not counted): ${c.names.join(', ')}`);
    for (const n of r.notes) console.log(`      ${n}`);
    for (const w of r.warnings) console.log(`      ! ${w}`);
    for (const e of r.errors) console.log(`      ✗ ${e}`);
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function printSummary(reports: FileReport[]): void {
  const items = reports.flatMap((r) => r.items);
  if (!items.length) return;
  const content = items.reduce((n, r) => n + r.coverage.content, 0);
  const covered = items.reduce((n, r) => n + r.coverage.covered, 0);
  const counted = items.filter((r) => r.coverage.content > 0);
  const ratios = counted.map((r) => r.coverage.ratio);
  const errors = items.reduce((n, r) => n + r.errors.length, 0);
  const warnings = items.reduce((n, r) => n + r.warnings.length, 0);
  const bands = [
    ratios.filter((x) => x >= COVERAGE_TARGET).length,
    ratios.filter((x) => x >= 0.95 && x < COVERAGE_TARGET).length,
    ratios.filter((x) => x < 0.95).length,
  ];
  console.log('');
  console.log(
    `Σ ${items.length} items · ${content} content tokens · ${pct(content ? covered / content : 1)} covered overall · ` +
      `median item ${pct(median(ratios))} · ≥98%: ${bands[0]} · 95–98%: ${bands[1]} · <95%: ${bands[2]}`,
  );
  console.log(`  median highest core word: #${median(counted.map((r) => r.coverage.maxOrder))} · ${errors} errors · ${warnings} warnings`);
  const all = new Map<string, Uncovered>();
  for (const r of items) {
    for (const u of r.coverage.uncovered) {
      const key = `${u.lemma}\u0000${u.why}`;
      const e = all.get(key) ?? { ...u, count: 0 };
      e.count += u.count;
      all.set(key, e);
    }
  }
  if (all.size) console.log(`  most frequent uncovered: ${uncoveredText([...all.values()].sort((a, b) => b.count - a.count), 25)}`);
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE =
  'Usage: node scripts/v2/coverage.ts <file.json|dir> [--ceiling N] [--grammar-max ORDER] [--fails] [--json] [--count-names]';

interface Args extends Options {
  target: string;
  fails: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const bad = (msg: string): never => {
    console.error(`${msg}\n${USAGE}`);
    process.exit(2);
  };
  const args: Partial<Args> & { fails: boolean; json: boolean } = { fails: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) bad(`${a} needs a whole number`);
      return v;
    };
    if (a === '--ceiling') args.ceiling = num();
    else if (a === '--grammar-max') args.grammarMax = num();
    else if (a === '--fails') args.fails = true;
    else if (a === '--json') args.json = true;
    else if (a === '--count-names') args.countNames = true;
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) bad(`unknown option ${a}`);
    else if (args.target) bad('give one file or directory');
    else args.target = a;
  }
  if (!args.target) bad('missing <file.json|dir>');
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolve(args.target);
  if (!existsSync(target)) {
    console.error(`not found: ${args.target}`);
    process.exit(2);
  }
  const ctx = await loadContext();
  if (!ctx.tk.hasJmdict && !args.json) console.log('(public/data/words.json missing: run npm run build:data for JMdict fallbacks)');
  const reports = jsonFiles(target).map((f) => analyzeFile(f, ctx, args));
  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) printFile(r, args.fails);
    printSummary(reports);
  }
  const errors = reports.some((r) => r.items.some((i) => i.errors.length));
  process.exit(errors ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(2);
  });
}
