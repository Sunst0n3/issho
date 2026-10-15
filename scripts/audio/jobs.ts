// Audio jobs: one per clip ref (TECH-DESIGN §2.2, §3.6.6), their content hashes and packs, and the manifest that
// indexes the finished clips. Pure: no engine, no file system (scripts/audio/run.ts drives the engine).

import { createHash } from 'node:crypto';
import type { KanaExamplesFile } from '../../src/lib/data.ts';
import type {
  AccentInfo,
  AudioClip,
  AudioManifest,
  CorePos,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  UnitSpec,
  VoiceId,
  WordEntry,
} from '../../src/lib/types.ts';
import { VOICES, clipRef, clipTextKey, roleVoice, rubyKana, rubyPlain, splitMoras } from '../../shared/voicevox.ts';

/**
 * Bump to regenerate every clip on purpose (new encoder settings, a better voice). The engine version is deliberately
 * not part of the hash: an engine upgrade must not regenerate (and re-commit) every clip.
 */
export const GEN_VERSION = 1;

/** Default kanji-word scope: anchor and staged words of the first 600 curriculum kanji. */
export const DEFAULT_KANJI_LIMIT = 600;

export type JobKind = 'word' | 'pitch' | 'sentence' | 'story' | 'line' | 'kana';

/** `--scope` values; 'all' selects every family. */
export const JOB_FAMILIES = ['kana', 'core', 'words', 'pitch', 'grammar', 'sentences', 'stories', 'roleplays', 'units'] as const;
export type JobFamily = (typeof JOB_FAMILIES)[number];

export interface AudioJob {
  /** Clip ref (AudioManifest.byRef key). */
  ref: string;
  family: JobFamily;
  kind: JobKind;
  voice: VoiceId;
  /** Ruby text: the engine reads rubyPlain(text); byText indexes clipTextKey(voice, text). */
  text: string;
  /** Expected reading (kana), checked against the engine's moras. */
  reading: string;
  /** Prefetch pack: 'kana', 'u01'…'u25', 'c01'…, 'misc'. */
  pack: string;
  /** Story sentences: the author's phrases (ruby), for AudioClip.phrases. */
  phrases?: string[];
  /** core:/word: refs: measure the accent (with が for noun-like words) and make the 'pitch:' clip. */
  word?: { nounLike: boolean };
  /** Kana sounds: the engine must say exactly these moras (は is "ha", never the particle "wa"). */
  exact?: boolean;
}

/** Everything the jobs are built from: the v2 public/data files (§2.1). */
export interface AudioSources {
  kana: KanaEntry[];
  kanaExamples: KanaExamplesFile;
  kanaRules: KanaRule[];
  coreWords: CoreWord[];
  words: WordEntry[];
  curriculum: Curriculum;
  grammar: GrammarPoint[];
  sentences: SentenceEntry[];
  stories: StoryEntry[];
  rolePlays: RolePlay[];
  units: UnitSpec[];
}

export interface BuildJobsOptions {
  /** JMdict words: anchor and staged words of the first N curriculum kanji only. */
  kanjiLimit?: number;
}

// ---------------------------------------------------------------------------
// Packs

const pad2 = (n: number) => String(n).padStart(2, '0');
export const KANA_PACK = 'kana';
export const MISC_PACK = 'misc';
export const unitPack = (unit: number | undefined) => (unit && unit > 0 ? `u${pad2(unit)}` : MISC_PACK);
export const chapterPack = (chapter: number | undefined) => (chapter && chapter > 0 ? `c${pad2(chapter)}` : MISC_PACK);

/** Order for a clip shared by several refs: it goes into the pack needed first. */
export function packRank(pack: string): number {
  if (pack === KANA_PACK) return 0;
  const m = /^([uc])(\d+)$/.exec(pack);
  if (m) return (m[1] === 'u' ? 0 : 1000) + Number(m[2]);
  return 1_000_000;
}

// ---------------------------------------------------------------------------
// Jobs

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/u;
const NOUN_LIKE_CORE = new Set<CorePos>(['noun', 'pronoun', 'adj-na', 'number', 'counter', 'demonstrative']);

/** `{written|kana}` when the word has its own written form, else the kana. */
export function wordText(kana: string, written?: string): string {
  return written && written !== kana ? `{${written}|${kana}}` : kana;
}

/** JMdict: any part of speech starting with 'n' (n, n-suf, num …) is noun-like. */
export function isNounLikeJmdict(pos: readonly string[]): boolean {
  return pos.some((p) => p.startsWith('n'));
}

/** Sub-kind of a ref for reports and sampling: 'kana', 'kanaEx', 'grammar#ex', 'rp', … */
export function refKind(ref: string): string {
  const prefix = ref.slice(0, ref.indexOf(':'));
  if (prefix === 'grammar') return ref.includes('#build') ? 'grammar#build' : 'grammar#ex';
  return prefix;
}

/** Every job of the current data except 'pitch:' jobs, which depend on measured accent (pitchJobFor). */
export function buildJobs(src: AudioSources, opts: BuildJobsOptions = {}): AudioJob[] {
  const kanjiLimit = opts.kanjiLimit ?? DEFAULT_KANJI_LIMIT;
  const jobs: AudioJob[] = [];
  const sentenceJob = (ref: string, family: JobFamily, kind: JobKind, voice: VoiceId, text: string, pack: string) =>
    jobs.push({ ref, family, kind, voice, text, reading: rubyKana(text), pack });

  // Kana: all 208 sounds, the example words and the rule practice words.
  for (const k of src.kana) {
    jobs.push({ ref: clipRef.kana(k.char), family: 'kana', kind: 'kana', voice: 'f', text: k.char, reading: k.char, pack: KANA_PACK, exact: true });
  }
  for (const [char, ex] of Object.entries(src.kanaExamples)) {
    jobs.push({ ref: clipRef.kanaEx(char), family: 'kana', kind: 'word', voice: 'f', text: wordText(ex.kana, ex.written), reading: ex.kana, pack: KANA_PACK });
  }
  for (const rule of src.kanaRules) {
    rule.practiceWords.forEach((w, n) => {
      jobs.push({ ref: clipRef.kanaRule(rule.id, n), family: 'kana', kind: 'word', voice: 'f', text: w.kana, reading: w.kana, pack: KANA_PACK });
    });
  }
  // Rule pairs: the grid plays kana:<side> for both sides (か→が, テ→ティ, おと→おっと). Sides outside the 208 sounds
  // get their own clip: extended katakana (ティ, ヴ) are one sound and read exactly; contrast words (おっと, ハート)
  // are words, matched like any word reading.
  const kanaRefs = new Set(jobs.filter((j) => j.kind === 'kana').map((j) => j.ref));
  for (const rule of src.kanaRules) {
    for (const pair of rule.pairs) {
      for (const side of [pair.from, pair.to]) {
        const ref = clipRef.kana(side);
        if (!side.trim() || kanaRefs.has(ref)) continue;
        kanaRefs.add(ref);
        const sound = splitMoras(side).length === 1;
        jobs.push({ ref, family: 'kana', kind: sound ? 'kana' : 'word', voice: 'f', text: side, reading: side, pack: KANA_PACK, ...(sound ? { exact: true } : {}) });
      }
    }
  }

  // Core words, in teaching order.
  for (const c of [...src.coreWords].sort((a, b) => a.order - b.order)) {
    jobs.push({
      ref: clipRef.word(`core:${c.id}`),
      family: 'core',
      kind: 'word',
      voice: 'f',
      text: wordText(c.kana, c.written),
      reading: c.kana,
      pack: unitPack(c.unit),
      word: { nounLike: NOUN_LIKE_CORE.has(c.pos) },
    });
  }

  // JMdict words: anchors and staged words of the first `kanjiLimit` kanji (core refs are core jobs already).
  const wordsById = new Map(src.words.map((w) => [w.id, w]));
  const seenWords = new Set<string>();
  for (const unit of [...src.curriculum.units].sort((a, b) => a.index - b.index)) {
    if (unit.index >= kanjiLimit) break;
    for (const ref of [unit.anchor, ...unit.staged]) {
      if (!ref?.startsWith('word:') || seenWords.has(ref)) continue;
      seenWords.add(ref);
      const w = wordsById.get(ref.slice('word:'.length));
      if (!w) continue;
      jobs.push({
        ref,
        family: 'words',
        kind: 'word',
        voice: 'f',
        text: wordText(w.kana, w.written),
        reading: w.kana,
        pack: chapterPack(unit.chapter),
        word: { nounLike: isNounLikeJmdict(w.pos) },
      });
    }
  }

  // Grammar examples and build items.
  for (const g of [...src.grammar].sort((a, b) => a.order - b.order)) {
    g.examples.forEach((ex, n) => sentenceJob(clipRef.grammarExample(g.id, n), 'grammar', 'sentence', 'f', ex.jp, unitPack(g.unit)));
    g.buildItems.forEach((b, n) => sentenceJob(clipRef.grammarBuild(g.id, n), 'grammar', 'sentence', 'f', b.jp, unitPack(g.unit)));
  }

  // Study sentences, in their unit's pack.
  for (const s of src.sentences) sentenceJob(clipRef.sentence(s.id), 'sentences', 'sentence', 'f', s.jp, unitPack(s.unit));

  // Stories: one clip per sentence, with phrase offsets.
  for (const story of src.stories) {
    story.sentences.forEach((s, n) => {
      jobs.push({
        ref: clipRef.story(story.id, n),
        family: 'stories',
        kind: 'story',
        voice: 'f',
        text: s.jp,
        reading: rubyKana(s.jp),
        pack: unitPack(story.unit),
        phrases: s.phrases.length > 0 ? [...s.phrases] : [s.jp],
      });
    });
  }

  // Role-plays: role a → f, role b → m.
  for (const rp of src.rolePlays) {
    rp.lines.forEach((line, n) => {
      sentenceJob(clipRef.rolePlay(rp.id, n), 'roleplays', 'line', roleVoice(line.role), line.jp, unitPack(rp.unit));
    });
  }

  // Units: scripted task lines and listen-check material.
  for (const u of src.units) {
    u.task.scripted.forEach((line, n) => {
      sentenceJob(clipRef.task(u.task.id, n), 'units', 'line', roleVoice(line.role), line.jp, unitPack(u.id));
    });
    for (const cd of u.canDos) {
      if (cd.check.kind === 'listen' && cd.check.material.trim()) {
        sentenceJob(clipRef.canDo(cd.id), 'units', 'sentence', 'f', cd.check.material.trim(), unitPack(u.id));
      }
    }
  }

  return jobs.filter((j) => j.text.trim() !== '' && j.reading.trim() !== '');
}

/** The 'pitch:' job of a word whose accent was measured with が: the word followed by が, in the word's pack. */
export function pitchJobFor(job: AudioJob): AudioJob {
  return {
    ref: clipRef.pitch(job.ref),
    family: 'pitch',
    kind: 'pitch',
    voice: job.voice,
    text: `${job.text}が`,
    reading: `${job.reading}が`,
    pack: job.pack,
  };
}

/** Sentence-type clips get the phrase accents of their query (when read from the text). */
export function isSentenceKind(kind: JobKind): boolean {
  return kind === 'sentence' || kind === 'story' || kind === 'line';
}

/** A reading that still contains a kanji cannot be checked: the job is reported and skipped. */
export function unreadable(job: AudioJob): boolean {
  return KANJI_RE.test(job.reading);
}

// ---------------------------------------------------------------------------
// Hashes and files

/**
 * sha256({ v, speaker, text: rubyPlain(text), reading }), first 16 hex characters. Two more fields enter the hash only
 * where they change what the clip holds, so a clip is always a function of its id whatever job made it first:
 * `exact: true` for kana sounds (a lone は must be "ha", while a word は may be read "wa"), and `phrases` (the author's
 * split) for story sentences, whose clips carry phrase offsets: a story sentence never shares a clip with a grammar
 * example of the same text, and moving a '／' mark regenerates its offsets.
 */
export function clipId(job: Pick<AudioJob, 'voice' | 'text' | 'reading'> & Partial<Pick<AudioJob, 'exact' | 'phrases'>>): string {
  const speaker = VOICES[job.voice].speaker;
  const json = JSON.stringify({
    v: GEN_VERSION,
    speaker,
    text: rubyPlain(job.text),
    reading: job.reading,
    ...(job.exact ? { exact: true } : {}),
    ...(job.phrases ? { phrases: job.phrases } : {}),
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/** Path under public/audio: 'a3/a3f09c1e5b2d7781.m4a'. */
export function clipFile(id: string): string {
  return `${id.slice(0, 2)}/${id}.m4a`;
}

// ---------------------------------------------------------------------------
// Sampling (--limit)

/**
 * A spread sample of `limit` jobs for trial runs: the limit is shared evenly across ref kinds (kana, kanaEx, core,
 * word, grammar examples, sentences, story sentences, role-play lines, …), and each kind's share is taken at even
 * steps through its jobs. Deterministic.
 */
export function sampleJobs(jobs: readonly AudioJob[], limit: number): AudioJob[] {
  if (limit >= jobs.length) return [...jobs];
  const groups = new Map<string, AudioJob[]>();
  for (const j of jobs) {
    const k = refKind(j.ref);
    const g = groups.get(k);
    if (g) g.push(j);
    else groups.set(k, [j]);
  }
  // Water-filling: small groups take all they have; the rest is shared by the larger ones.
  const quota = new Map<string, number>();
  let left = limit;
  const open = [...groups.entries()].sort((a, b) => a[1].length - b[1].length);
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const [kind, group] = open[0];
    if (group.length <= share) {
      quota.set(kind, group.length);
      left -= group.length;
      open.shift();
      continue;
    }
    let extra = left - share * open.length;
    for (const [k] of open) {
      quota.set(k, share + (extra > 0 ? 1 : 0));
      extra--;
    }
    break;
  }
  const picked = new Set<AudioJob>();
  for (const [kind, group] of groups) {
    const q = quota.get(kind) ?? 0;
    for (let i = 0; i < q; i++) picked.add(group[Math.floor((i * group.length) / q)]);
  }
  return jobs.filter((j) => picked.has(j));
}

// ---------------------------------------------------------------------------
// Accent cache (scripts/audio/accent-cache.json)

/** Accent measured for a word clip, keyed by clip id; null = measured, nothing reliable to record. */
export interface AccentCacheEntry {
  /** Measured as a noun-like word (with が). */
  noun: boolean;
  accent: AccentInfo | null;
}
export type AccentCache = Record<string, AccentCacheEntry>;

// ---------------------------------------------------------------------------
// Manifest

/** A finished clip and the job it answers. */
export interface ClipEntry {
  job: AudioJob;
  id: string;
  clip: AudioClip;
}

/** AudioClip with a stable key order. */
function orderedClip(c: AudioClip): AudioClip {
  const out: AudioClip = { file: c.file, ms: c.ms, voice: c.voice, pack: c.pack, via: c.via };
  if (c.phrases) out.phrases = c.phrases;
  if (c.accentPhrases) out.accentPhrases = c.accentPhrases;
  return out;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The manifest of the finished clips. A clip shared by several refs goes into the pack needed first. byText holds
 * each clip's full clipTextKey and, only when every clip of that voice with the same plain text has the same reading
 * (one full key), the plain-only key `${voice}|${plain}|` pointing where the full key points, so plain-kanji callers
 * still hit while homographs never collide. (Clips that differ only in what they carry, such as a story sentence and
 * a grammar example of the same text, say the same thing: they do not make the plain text ambiguous.)
 */
export function buildManifest(entries: readonly ClipEntry[], engine: string, generatedAt: string): AudioManifest {
  const clips = new Map<string, AudioClip>();
  const byRef = new Map<string, string>();
  for (const { job, id, clip } of entries) {
    byRef.set(job.ref, id);
    const prev = clips.get(id);
    if (!prev || packRank(clip.pack) < packRank(prev.pack)) clips.set(id, orderedClip(prev ? { ...prev, pack: clip.pack } : clip));
  }

  const better = (a: string, b: string) => {
    const ra = packRank(clips.get(a)!.pack);
    const rb = packRank(clips.get(b)!.pack);
    return ra !== rb ? ra < rb : a < b;
  };
  const byText = new Map<string, string>();
  const plainKeys = new Map<string, Set<string>>();
  for (const { job, id } of entries) {
    const key = clipTextKey(job.voice, job.text);
    const current = byText.get(key);
    if (!current || (current !== id && better(id, current))) byText.set(key, id);
    const plainKey = key.slice(0, key.lastIndexOf('|') + 1);
    const keys = plainKeys.get(plainKey);
    if (keys) keys.add(key);
    else plainKeys.set(plainKey, new Set([key]));
  }
  for (const [plainKey, keys] of plainKeys) {
    if (keys.size === 1 && !byText.has(plainKey)) byText.set(plainKey, byText.get([...keys][0])!);
  }

  return {
    version: 1,
    generatedAt,
    engine,
    credits: [VOICES.f.credit, VOICES.m.credit],
    clips: sortedRecord(clips),
    byRef: sortedRecord(byRef),
    byText: sortedRecord(byText),
  };
}

/** accent.json from the word jobs' clips and the accent cache: only verified entries (§2.1). */
export function buildAccentFile(entries: readonly ClipEntry[], cache: AccentCache): Record<string, AccentInfo> {
  const out: [string, AccentInfo][] = [];
  for (const { job, id, clip } of entries) {
    if (!job.word || clip.via !== 'text') continue;
    const hit = cache[id];
    if (hit && hit.noun === job.word.nounLike && hit.accent) out.push([job.ref, hit.accent]);
  }
  return sortedRecord(out);
}

/**
 * JSON with one entry per line inside each top-level map: valid JSON, small, and diff-friendly in git.
 * Top-level scalars and arrays stay on one line.
 */
export function formatJsonLines(value: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = Object.keys(value);
  keys.forEach((key, i) => {
    const v = value[key];
    const comma = i < keys.length - 1 ? ',' : '';
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.entries(v as Record<string, unknown>);
      if (inner.length === 0) {
        lines.push(`  ${JSON.stringify(key)}: {}${comma}`);
        return;
      }
      lines.push(`  ${JSON.stringify(key)}: {`);
      inner.forEach(([k, x], j) => lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(x)}${j < inner.length - 1 ? ',' : ''}`));
      lines.push(`  }${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(v)}${comma}`);
    }
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

/** accent.json / accent-cache.json: one entry per line. */
export function formatRecordLines(record: Record<string, unknown>): string {
  const inner = Object.entries(record);
  if (inner.length === 0) return '{}\n';
  return `{\n${inner.map(([k, v], i) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < inner.length - 1 ? ',' : ''}`).join('\n')}\n}\n`;
}
