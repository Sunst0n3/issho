// Generates the pre-recorded voice clips in public/audio/ (and public/data/accent.json) from the built study data in
// public/data/, with a local VOICEVOX engine and ffmpeg (or afconvert). TECH-DESIGN §2.2 and §3.6.6.
//
//   node scripts/audio/generate.ts                (npm run build:audio)
//     [--scope all|kana|core|words|pitch|grammar|sentences|stories|roleplays|units[,…]]
//     [--kanji-limit 600] [--engine http://127.0.0.1:50021] [--concurrency 2] [--dry-run] [--limit N]
//     [--encoder ffmpeg|afconvert] [--prune] [--data public/data]
//
// Runs are incremental: a clip whose content hash is already in the manifest (and on disk) is reused. Unreferenced
// clips are removed from the manifest and deleted; a run that would delete many files keeps them unless --prune.
// Failures (the engine misread both the text and its reading) are listed in scripts/audio/last-run.json.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { KanaExamplesFile } from '../../src/lib/data.ts';
import type {
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  UnitSpec,
  WordEntry,
} from '../../src/lib/types.ts';
import { VOICES } from '../../shared/voicevox.ts';
import { detectEncoder, makeEncoder, type EncoderName } from './encode.ts';
import { DEFAULT_ENGINE, HttpEngine } from './engine.ts';
import {
  DEFAULT_KANJI_LIMIT,
  JOB_FAMILIES,
  buildJobs,
  formatJsonLines,
  formatRecordLines,
  sampleJobs,
  type AccentCache,
  type AudioJob,
  type AudioSources,
  type JobFamily,
} from './jobs.ts';
import { runJobs, type ClipStore, type KindStats, type RunResult } from './run.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AUDIO = join(ROOT, 'public', 'audio');
const MANIFEST = join(AUDIO, 'manifest.json');
const TMP = join(ROOT, '.cache', 'audio-tmp');
const ACCENT_CACHE = join(ROOT, 'scripts', 'audio', 'accent-cache.json');
const LAST_RUN = join(ROOT, 'scripts', 'audio', 'last-run.json');

/** Without --prune, a run deletes at most this many unreferenced clips (or 10 % of the manifest, if more). */
const PRUNE_GUARD = 50;

class UsageError extends Error {}

const rel = (p: string) => relative(ROOT, p) || '.';

// ---------------------------------------------------------------------------
// Arguments

interface Args {
  scope: Set<JobFamily>;
  kanjiLimit: number;
  engine: string;
  concurrency: number;
  dryRun: boolean;
  limit: number | null;
  encoder: EncoderName | undefined;
  prune: boolean;
  data: string;
}

function parseCli(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: 'string', default: 'all' },
      'kanji-limit': { type: 'string', default: String(DEFAULT_KANJI_LIMIT) },
      engine: { type: 'string', default: DEFAULT_ENGINE },
      concurrency: { type: 'string', default: '2' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      encoder: { type: 'string' },
      prune: { type: 'boolean', default: false },
      data: { type: 'string', default: join(ROOT, 'public', 'data') },
    },
    strict: true,
  });
  const int = (name: string, raw: string, min: number) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer ≥ ${min} (got "${raw}")`);
    return n;
  };
  const scope = new Set<JobFamily>();
  for (const s of values.scope.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (s === 'all') JOB_FAMILIES.forEach((f) => scope.add(f));
    else if ((JOB_FAMILIES as readonly string[]).includes(s)) scope.add(s as JobFamily);
    else throw new UsageError(`--scope: unknown "${s}" (use all or ${JOB_FAMILIES.join(', ')})`);
  }
  if (values.encoder && values.encoder !== 'ffmpeg' && values.encoder !== 'afconvert') {
    throw new UsageError('--encoder must be ffmpeg or afconvert');
  }
  return {
    scope,
    kanjiLimit: int('kanji-limit', values['kanji-limit'], 0),
    engine: values.engine,
    concurrency: int('concurrency', values.concurrency, 1),
    dryRun: values['dry-run'],
    limit: values.limit === undefined ? null : int('limit', values.limit, 1),
    encoder: values.encoder as EncoderName | undefined,
    prune: values.prune,
    data: values.data,
  };
}

// ---------------------------------------------------------------------------
// Data (public/data, v2)

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new UsageError(`${rel(path)}: ${(err as Error).message}`);
  }
}

function loadSources(dir: string, warn: (m: string) => void): AudioSources {
  const need = (name: string) => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new UsageError(`${rel(path)} is missing: run npm run build:data first`);
    return path;
  };
  const optional = <T>(name: string, empty: T): T => {
    const path = join(dir, name);
    if (existsSync(path)) return readJson<T>(path);
    warn(`${rel(path)} is not built yet: no clips for it`);
    return empty;
  };
  const curriculum = readJson<Curriculum>(need('curriculum.json'));
  const coreWords = readJson<CoreWord[]>(need('content/core-words.json'));
  const grammar = readJson<GrammarPoint[]>(need('content/grammar.json'));
  const sentences = readJson<SentenceEntry[]>(need('content/sentences.json'));
  const v2 =
    curriculum.version === 2 &&
    coreWords.every((c) => typeof c.unit === 'number') &&
    grammar.every((g) => typeof g.unit === 'number') &&
    sentences.every((s) => typeof s.unit === 'number');
  if (!v2) throw new UsageError(`${rel(dir)} is not the v2 data build (no units): run npm run build:data first`);
  return {
    kana: readJson<KanaEntry[]>(need('kana.json')),
    kanaExamples: readJson<KanaExamplesFile>(need('content/kana-examples.json')),
    kanaRules: readJson<KanaRule[]>(need('content/kana-rules.json')),
    coreWords,
    words: readJson<WordEntry[]>(need('words.json')),
    curriculum,
    grammar,
    sentences,
    stories: optional<StoryEntry[]>('content/stories.json', []),
    rolePlays: optional<RolePlay[]>('content/roleplays.json', []),
    units: optional<UnitSpec[]>('content/units.json', []),
  };
}

// ---------------------------------------------------------------------------
// Clip files

class FsClipStore implements ClipStore {
  private readonly encode: ReturnType<typeof makeEncoder>;

  constructor(encoder: EncoderName) {
    this.encode = makeEncoder(encoder);
  }

  has(file: string): boolean {
    return existsSync(join(AUDIO, file));
  }

  /** WAV → .cache/audio-tmp → encode → rename into public/audio (a killed run never leaves a half-written clip). */
  async put(file: string, wav: Uint8Array): Promise<number> {
    const base = file.replace(/^.*\//, '').replace(/\.m4a$/, '');
    const wavPath = join(TMP, `${base}.wav`);
    const tmpOut = join(TMP, `${base}.m4a`);
    const out = join(AUDIO, file);
    mkdirSync(TMP, { recursive: true });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(wavPath, wav);
    try {
      await this.encode(wavPath, tmpOut);
      renameSync(tmpOut, out);
    } finally {
      rmSync(wavPath, { force: true });
      rmSync(tmpOut, { force: true });
    }
    return statSync(out).size;
  }
}

/** Every .m4a under public/audio, as manifest file paths ('a3/a3f0….m4a'). */
function clipFilesOnDisk(): string[] {
  if (!existsSync(AUDIO)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(AUDIO, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(AUDIO, dir.name))) if (f.endsWith('.m4a')) out.push(`${dir.name}/${f}`);
  }
  return out.sort();
}

function removeEmptyDirs(): void {
  if (!existsSync(AUDIO)) return;
  for (const dir of readdirSync(AUDIO, { withFileTypes: true })) {
    if (dir.isDirectory() && readdirSync(join(AUDIO, dir.name)).length === 0) rmdirSync(join(AUDIO, dir.name));
  }
}

/**
 * Write-then-rename, so a run killed during a checkpoint never leaves a truncated manifest (which would make the next
 * run unable to reuse any clip) or accent cache.
 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function writeOutputs(dataDir: string, r: Pick<RunResult, 'manifest' | 'accent' | 'accentCache'>): void {
  mkdirSync(AUDIO, { recursive: true });
  writeAtomic(MANIFEST, formatJsonLines(r.manifest as unknown as Record<string, unknown>));
  writeAtomic(join(dataDir, 'accent.json'), formatRecordLines(r.accent));
  writeAtomic(ACCENT_CACHE, formatRecordLines(r.accentCache));
}

// ---------------------------------------------------------------------------
// Report

const KIND_ORDER = ['kana', 'kanaEx', 'kanaRule', 'core', 'word', 'pitch', 'grammar#ex', 'grammar#build', 'sentence', 'story', 'rp', 'task', 'cando'];

function sumStats(all: KindStats[]): KindStats {
  const t: KindStats = { jobs: 0, reused: 0, generated: 0, failed: 0, viaKana: 0, pending: 0, bytes: 0, audioMs: 0, workMs: 0 };
  for (const s of all) for (const k of Object.keys(t) as (keyof KindStats)[]) t[k] += s[k];
  return t;
}

function printReport(r: RunResult, wallMs: number): void {
  const kinds = Object.keys(r.stats).sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a);
    const ib = KIND_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const kb = (b: number) => (b / 1024).toFixed(1);
  console.log(`\n${'kind'.padEnd(14)}${pad('jobs', 7)}${pad('reused', 8)}${pad('new', 7)}${pad('failed', 8)}${pad('viaKana', 9)}${pad('pending', 9)}${pad('KB new', 9)}${pad('KB/clip', 9)}${pad('s/clip', 8)}${pad('audio s', 9)}`);
  const row = (name: string, s: KindStats) =>
    console.log(
      `${name.padEnd(14)}${pad(s.jobs, 7)}${pad(s.reused, 8)}${pad(s.generated, 7)}${pad(s.failed, 8)}${pad(s.viaKana, 9)}${pad(s.pending, 9)}` +
        `${pad(kb(s.bytes), 9)}${pad(s.generated ? kb(s.bytes / s.generated) : '-', 9)}` +
        `${pad(s.generated ? (s.workMs / s.generated / 1000).toFixed(2) : '-', 8)}${pad((s.audioMs / 1000).toFixed(1), 9)}`,
    );
  for (const k of kinds) row(k, r.stats[k]);
  const total = sumStats(Object.values(r.stats));
  row('total', total);
  const attempted = total.generated + total.failed;
  const clips = Object.keys(r.manifest.clips).length;
  console.log(
    `\nGenerated ${total.generated} clips (voice f: ${r.generatedByVoice.f}, m: ${r.generatedByVoice.m})` +
      ` in ${(wallMs / 1000).toFixed(1)} s` +
      (total.generated ? `: ${((total.generated / wallMs) * 60_000).toFixed(0)} clips/min, ${(total.audioMs / wallMs).toFixed(2)} s of audio per second` : '') +
      '.',
  );
  if (attempted) {
    console.log(`Failures: ${total.failed} of ${attempted} attempted (${((100 * total.failed) / attempted).toFixed(2)} %); via kana: ${total.viaKana}.`);
  }
  console.log(`Manifest: ${clips} clips, ${Object.keys(r.manifest.byRef).length} refs, ${Object.keys(r.manifest.byText).length} text keys; accent entries: ${Object.keys(r.accent).length}; jobs without a clip: ${r.missing}.`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2));
  const started = new Date();
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const sources = loadSources(args.data, warn);
  const jobs = buildJobs(sources, { kanjiLimit: args.kanjiLimit });
  const inScope = jobs.filter((j) => args.scope.has(j.family));
  const selectedJobs: AudioJob[] = args.limit === null ? inScope : sampleJobs(inScope, args.limit);
  const selected = new Set(selectedJobs.map((j) => j.ref));

  let engine: HttpEngine | null = new HttpEngine(args.engine);
  let engineLabel = '';
  let encoder: EncoderName | null = null;
  try {
    const version = await engine.version();
    engineLabel = `VOICEVOX ${version}`;
    const styles = await engine.styleIds();
    const missing = Object.values(VOICES).filter((v) => !styles.has(v.speaker));
    if (missing.length) {
      console.error(`The engine has no style ${missing.map((v) => `${v.speaker} (${v.style})`).join(', ')}.`);
      if (!args.dryRun) return 2;
    }
  } catch (err) {
    if (!args.dryRun) {
      console.error(`No VOICEVOX engine at ${args.engine} (${(err as Error).message}). Start it, or pass --engine.`);
      return 2;
    }
  }
  if (!args.dryRun) {
    encoder = detectEncoder(args.encoder);
    if (!encoder) {
      console.error(args.encoder ? `${args.encoder} is not installed.` : 'Neither ffmpeg nor afconvert is installed.');
      return 2;
    }
  }

  const previous = existsSync(MANIFEST) ? readJson<AudioManifest>(MANIFEST) : null;
  const accentCache = existsSync(ACCENT_CACHE) ? readJson<AccentCache>(ACCENT_CACHE) : {};
  if (args.dryRun) engine = null;
  engineLabel ||= previous?.engine || 'VOICEVOX';

  console.log(
    `${args.dryRun ? 'Planning' : 'Generating'} ${selected.size} of ${jobs.length} jobs` +
      ` (scope ${[...args.scope].join(',')}${args.limit !== null ? `, sample of ${args.limit}` : ''}, kanji words of the first ${args.kanjiLimit} kanji)` +
      (args.dryRun ? '' : ` with ${engineLabel}, ${encoder}, concurrency ${args.concurrency}`) +
      '.',
  );

  let lastPrint = 0;
  const t0 = performance.now();
  const result = await runJobs(jobs, {
    engine,
    store: new FsClipStore(encoder ?? 'ffmpeg'),
    previous,
    accentCache,
    engineLabel,
    selected,
    // Accent and pitch clips for words that already have clips: a full run (or --scope pitch), never a sample.
    pitch: args.scope.has('pitch') && args.limit === null,
    concurrency: args.concurrency,
    onCheckpoint: (snap) => writeOutputs(args.data, snap),
    onProgress: (p) => {
      const t = performance.now();
      if (t - lastPrint < 5000 && p.done !== p.total) return;
      lastPrint = t;
      const rate = p.generated / ((t - t0) / 60_000);
      const eta = rate > 0 && p.done < p.total ? ` · about ${Math.ceil(((p.total - p.done) / p.done) * ((t - t0) / 60_000))} min left` : '';
      console.log(`  ${String(p.done).padStart(5)}/${p.total} jobs · ${p.generated} new clips (${rate.toFixed(0)}/min) · ${p.failed} failed${eta}`);
    },
  });
  const wallMs = performance.now() - t0;

  if (args.dryRun) {
    printReport(result, wallMs);
    console.log('\nDry run: nothing was written.');
    return 0;
  }

  writeOutputs(args.data, result);

  // Unreferenced clip files: delete them, unless suspiciously many would go (a half-built public/data?).
  const keep = new Set(Object.values(result.manifest.clips).map((c) => c.file));
  const stale = clipFilesOnDisk().filter((f) => !keep.has(f));
  const guard = Math.max(PRUNE_GUARD, Math.ceil(keep.size / 10));
  if (stale.length > 0 && (args.prune || stale.length <= guard)) {
    for (const f of stale) unlinkSync(join(AUDIO, f));
    removeEmptyDirs();
    console.log(`Deleted ${stale.length} unreferenced clip files.`);
  } else if (stale.length > 0) {
    warn(`${stale.length} clip files are no longer referenced; kept because that is more than ${guard}. Re-run with --prune to delete them.`);
  }
  // The temp folder holds nothing between runs; leave .cache itself only if something else uses it.
  if (existsSync(TMP) && readdirSync(TMP).length === 0) rmdirSync(TMP);
  if (existsSync(dirname(TMP)) && readdirSync(dirname(TMP)).length === 0) rmdirSync(dirname(TMP));

  const allWarnings = [...warnings, ...result.warnings];
  const totals = sumStats(Object.values(result.stats));
  writeFileSync(
    LAST_RUN,
    JSON.stringify(
      {
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        engine: engineLabel,
        encoder,
        args: { ...args, scope: [...args.scope] },
        jobs: jobs.length,
        selected: selected.size,
        wallMs: Math.round(wallMs),
        totals,
        stats: result.stats,
        aborted: result.aborted ?? null,
        failures: result.failures,
        warnings: allWarnings,
      },
      null,
      2,
    ) + '\n',
  );

  printReport(result, wallMs);
  if (allWarnings.length) {
    console.log(`\n${allWarnings.length} warning(s):`);
    for (const w of allWarnings.slice(0, 30)) console.log(`  - ${w}`);
    if (allWarnings.length > 30) console.log(`  … and ${allWarnings.length - 30} more in ${rel(LAST_RUN)}`);
  }
  if (result.failures.length) {
    console.log(`\n${result.failures.length} failed job(s) (no clip; the app falls back to server TTS or the device voice):`);
    for (const f of result.failures.slice(0, 20)) {
      console.log(`  - ${f.ref}  ${f.text}  expected ${f.reading}  ${f.error ?? `heard ${f.heard.join(' / ')}`}`);
    }
    if (result.failures.length > 20) console.log(`  … and ${result.failures.length - 20} more in ${rel(LAST_RUN)}`);
  }
  if (result.aborted) {
    console.error(`\nStopped early: ${result.aborted}. The manifest holds what was done; run again to resume.`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
