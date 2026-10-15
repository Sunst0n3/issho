// Runs audio jobs against a VOICEVOX engine (TECH-DESIGN §3.6.6, per-job steps 1–8). The engine and the clip store
// are injected, so tests run it with recorded queries and no files.

import type { AccentInfo, AudioClip, AudioManifest, VoiceId } from '../../src/lib/types.ts';
import {
  VOICES,
  accentFromQueries,
  gaAligned,
  phraseAccents,
  phraseOffsetsMs,
  queryMoras,
  readingMatches,
  rubyKana,
  rubyPlain,
  toKatakana,
  type VvQuery,
} from '../../shared/voicevox.ts';
import { wavDurationMs } from './encode.ts';
import { SYNTHESIS, type Engine } from './engine.ts';
import {
  buildAccentFile,
  buildManifest,
  clipFile,
  clipId,
  isSentenceKind,
  pitchJobFor,
  refKind,
  unreadable,
  type AccentCache,
  type AudioJob,
  type ClipEntry,
} from './jobs.ts';

/** Where finished clips live (public/audio in the CLI). */
export interface ClipStore {
  has(file: string): boolean;
  /** Encodes the WAV into the clip file and returns the clip's size in bytes. */
  put(file: string, wav: Uint8Array): Promise<number>;
}

export interface JobFailure {
  ref: string;
  text: string;
  reading: string;
  /** What the engine read, per query (katakana moras). */
  heard: string[];
  /** An engine or encoder error instead of a misreading. */
  error?: string;
}

export interface KindStats {
  /** Jobs of this kind in the current data. */
  jobs: number;
  /** Refs given an existing clip: carried over from the previous manifest, or shared with another ref this run. */
  reused: number;
  /** Clips made this run (a clip shared by several refs counts once, for the first ref). */
  generated: number;
  failed: number;
  /** Generated from the kana reading because the engine misread the text. */
  viaKana: number;
  /** Would be generated, but this run had no engine (dry run) or did not select the job. */
  pending: number;
  /** Bytes and audio length of the clips generated this run. */
  bytes: number;
  audioMs: number;
  /** Wall time spent on queries, synthesis and encoding for this kind, summed over workers. */
  workMs: number;
}

export interface Progress {
  done: number;
  total: number;
  generated: number;
  failed: number;
  job: AudioJob;
}

export interface RunOptions {
  /** null: plan only (dry run). */
  engine: Engine | null;
  store: ClipStore;
  previous: AudioManifest | null;
  accentCache: AccentCache;
  /** Display label for the manifest ('VOICEVOX 0.25.2'). */
  engineLabel: string;
  /** Refs that may be generated this run (scope and --limit). Default: every job. */
  selected?: ReadonlySet<string>;
  /** Also measure accent and make 'pitch:' clips for words whose clip already exists (--scope pitch). */
  pitch?: boolean;
  concurrency?: number;
  /** Write the manifest every N new clips (default 200), so a run can be resumed. */
  checkpointEvery?: number;
  onCheckpoint?: (snapshot: { manifest: AudioManifest; accent: Record<string, AccentInfo>; accentCache: AccentCache }) => void;
  onProgress?: (p: Progress) => void;
  /** Consecutive engine errors before the run gives up (the engine is down). Default 10. */
  maxConsecutiveErrors?: number;
  now?: () => Date;
}

export interface RunResult {
  manifest: AudioManifest;
  accent: Record<string, AccentInfo>;
  accentCache: AccentCache;
  failures: JobFailure[];
  warnings: string[];
  /** Per ref kind ('kana', 'core', 'grammar#ex', 'rp', 'pitch', …). */
  stats: Record<string, KindStats>;
  /** Jobs without a clip after the run (failed, not selected, or dry run). */
  missing: number;
  /** Clips generated this run, per voice. */
  generatedByVoice: Record<VoiceId, number>;
  /** Set when the run stopped early because the engine stopped answering; the result holds what was done. */
  aborted?: string;
}

export class EngineDownError extends Error {}

const emptyStats = (): KindStats => ({
  jobs: 0, reused: 0, generated: 0, failed: 0, viaKana: 0, pending: 0, bytes: 0, audioMs: 0, workMs: 0,
});

/** Kana sounds: exact moras, so は must come back as ハ (the engine reads a lone は as the particle ワ). */
function exactKanaMatches(q: VvQuery, reading: string): boolean {
  const fold = (s: string) => toKatakana(s.normalize('NFKC')).replace(/ヲ/g, 'オ').replace(/ヂ/g, 'ジ').replace(/ヅ/g, 'ズ');
  return fold(queryMoras(q)) === fold(reading);
}

function matches(job: AudioJob, q: VvQuery): boolean {
  return job.exact ? exactKanaMatches(q, job.reading) : readingMatches(q, job.reading);
}

type Generated = { clip: AudioClip; query: VvQuery; bytes: number } | { failure: JobFailure };

/**
 * Word jobs that share a clip (same voice, text and reading, such as two kana-only words そば) share its one accent
 * measurement, because the accent cache is keyed by clip id. Measure it with が when any of them is noun-like;
 * otherwise each would re-measure over the other's entry on every run, and accent.json would flip between runs.
 */
function shareNounLike(jobs: readonly AudioJob[]): readonly AudioJob[] {
  const nounIds = new Set(jobs.filter((j) => j.word?.nounLike).map((j) => clipId(j)));
  if (nounIds.size === 0) return jobs;
  return jobs.map((j) => (j.word && !j.word.nounLike && nounIds.has(clipId(j)) ? { ...j, word: { nounLike: true } } : j));
}

/**
 * A run that changed nothing keeps the previous `generatedAt`, so manifest.json stays byte-identical: a re-run adds
 * nothing to git and does not make every device download the precached manifest again.
 */
function keepGeneratedAt(next: AudioManifest, previous: AudioManifest | null): AudioManifest {
  if (!previous) return next;
  const same = JSON.stringify({ ...next, generatedAt: '' }) === JSON.stringify({ ...previous, generatedAt: '' });
  return same ? { ...next, generatedAt: previous.generatedAt } : next;
}

export async function runJobs(input: readonly AudioJob[], opts: RunOptions): Promise<RunResult> {
  const jobs = shareNounLike(input);
  const { engine, store } = opts;
  const prevClips = opts.previous?.clips ?? {};
  const cache: AccentCache = { ...opts.accentCache };
  const now = opts.now ?? (() => new Date());
  const results = new Map<string, ClipEntry>();
  const failures: JobFailure[] = [];
  const warnings: string[] = [];
  const stats: Record<string, KindStats> = {};
  let aborted: string | undefined;
  const generatedByVoice: Record<VoiceId, number> = { f: 0, m: 0 };
  const statsFor = (ref: string) => (stats[refKind(ref)] ??= emptyStats());
  const pitchCounted = new Set<string>();
  /** A pitch job exists once its word's accent has が: count it once, however it is reached. */
  const countPitch = (ref: string) => {
    if (!pitchCounted.has(ref)) {
      pitchCounted.add(ref);
      statsFor(ref).jobs++;
    }
  };
  const isSelected = (job: AudioJob) => !opts.selected || opts.selected.has(job.ref);
  const checkpointEvery = opts.checkpointEvery ?? 200;
  const maxErrors = opts.maxConsecutiveErrors ?? 10;

  const ids = new Map<AudioJob, string>();
  for (const job of jobs) ids.set(job, clipId(job));
  /** Clips that a sentence-type ref uses: they carry phrase accents (when read via 'text'), whichever ref made them. */
  const accentIds = new Set(jobs.filter((j) => isSentenceKind(j.kind)).map((j) => ids.get(j)!));
  /** Clips that at least one ref may generate this run. */
  const selectedIds = new Set(jobs.filter(isSelected).map((j) => ids.get(j)!));

  const carry = (job: AudioJob, id: string): boolean => {
    const prev = prevClips[id];
    if (!prev || !store.has(clipFile(id))) return false;
    // A word clip that a sentence-type ref now shares lacks its phrase accents: remake it when this run may.
    const wantsAccent = accentIds.has(id) && prev.via === 'text';
    if (wantsAccent && !prev.accentPhrases && selectedIds.has(id)) return false;
    const clip: AudioClip = { ...prev, file: clipFile(id), pack: job.pack };
    if (!wantsAccent) delete clip.accentPhrases;
    results.set(job.ref, { job, id, clip });
    statsFor(job.ref).reused++;
    return true;
  };
  const cachedAccent = (job: AudioJob, id: string) => {
    const hit = cache[id];
    return hit && job.word && hit.noun === job.word.nounLike ? hit : undefined;
  };

  // Pass 1: carry over every clip that is still current (no engine needed).
  for (const job of jobs) {
    const id = ids.get(job)!;
    statsFor(job.ref).jobs++;
    if (!carry(job, id)) continue;
    if (job.word && results.get(job.ref)!.clip.via === 'text' && cachedAccent(job, id)?.accent?.withGa) {
      const pitch = pitchJobFor(job);
      countPitch(pitch.ref);
      carry(pitch, clipId(pitch));
    }
  }

  // Pass 2: what needs the engine.
  const needsWork = (job: AudioJob): boolean => {
    const id = ids.get(job)!;
    const entry = results.get(job.ref);
    if (!entry) return isSelected(job);
    if (!job.word || entry.clip.via !== 'text' || !(isSelected(job) || opts.pitch)) return false;
    const hit = cachedAccent(job, id);
    return !hit || (Boolean(hit.accent?.withGa) && !results.has(pitchJobFor(job).ref));
  };
  const work = jobs.filter(needsWork);

  if (!engine) {
    attachShared();
    for (const job of jobs) if (!results.has(job.ref)) statsFor(job.ref).pending++;
    return finish();
  }

  const generating = new Map<string, Promise<Generated>>();
  const measuring = new Map<string, Promise<VvQuery | null>>();
  let newClips = 0;
  let sinceCheckpoint = 0;
  let consecutiveErrors = 0;
  let done = 0;
  let failedCount = 0;
  const madeClips = new Set<string>();

  const added = (job: AudioJob, id: string, gen: { clip: AudioClip; bytes: number }, workMs: number) => {
    results.set(job.ref, { job, id, clip: { ...gen.clip, pack: job.pack } });
    const s = statsFor(job.ref);
    if (madeClips.has(id)) {
      // Another ref of this run already made this clip (same voice, text and reading).
      s.reused++;
      return;
    }
    madeClips.add(id);
    s.generated++;
    s.bytes += gen.bytes;
    s.audioMs += gen.clip.ms;
    s.workMs += workMs;
    if (gen.clip.via === 'kana') s.viaKana++;
    generatedByVoice[gen.clip.voice]++;
    newClips++;
    if (++sinceCheckpoint >= checkpointEvery && opts.onCheckpoint) {
      sinceCheckpoint = 0;
      opts.onCheckpoint(snapshot());
    }
  };

  const fail = (job: AudioJob, failure: JobFailure) => {
    failures.push(failure);
    statsFor(job.ref).failed++;
    failedCount++;
  };

  /** Engine calls with a guard: many errors in a row mean the engine is gone, so stop instead of failing every job. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      consecutiveErrors = 0;
      return out;
    } catch (err) {
      if (++consecutiveErrors >= maxErrors) throw new EngineDownError(`engine failed ${consecutiveErrors} times in a row: ${(err as Error).message}`);
      throw err;
    }
  };

  /** Steps 2, 5–8: query (text, then kana), verify, synthesize, encode, phrase data. */
  const generate = async (job: AudioJob, id: string): Promise<Generated> => {
    const speaker = VOICES[job.voice].speaker;
    const plain = rubyPlain(job.text);
    const heard: string[] = [];
    let q = await call(() => engine.query(plain, speaker));
    heard.push(queryMoras(q));
    let via: AudioClip['via'] | null = matches(job, q) ? 'text' : null;
    if (!via) {
      const kanaText = job.exact ? toKatakana(job.reading) : job.reading;
      if (kanaText !== plain) {
        q = await call(() => engine.query(kanaText, speaker));
        heard.push(queryMoras(q));
        if (matches(job, q)) via = 'kana';
      }
    }
    if (!via) return { failure: { ref: job.ref, text: job.text, reading: job.reading, heard } };

    const synthQuery = { ...q, ...SYNTHESIS };
    const wav = await call(() => engine.synthesize(synthQuery, speaker));
    const file = clipFile(id);
    const bytes = await store.put(file, wav);
    const clip: AudioClip = { file, ms: wavDurationMs(wav), voice: job.voice, pack: job.pack, via };
    if (job.kind === 'story' && job.phrases) {
      const { offsets, aligned } = phraseOffsetsMs(synthQuery, job.phrases.map(rubyKana));
      clip.phrases = offsets;
      if (!aligned) warnings.push(`${job.ref}: phrase offsets are proportional (the phrases' moras do not line up)`);
    }
    if (accentIds.has(id) && via === 'text') clip.accentPhrases = phraseAccents(q);
    return { clip, query: q, bytes };
  };

  /**
   * Step 3: the word's accent, only from a clip read via 'text' (its own spelling, or a kana-only word). Noun-like
   * words are measured with が; without a usable が query a noun keeps only an unambiguous accent (heiban and odaka
   * sound the same alone). Returns the verified が query when the accent came from it.
   */
  const measure = async (job: AudioJob, id: string, alone: VvQuery | undefined): Promise<VvQuery | null> => {
    const noun = job.word!.nounLike;
    const speaker = VOICES[job.voice].speaker;
    const plain = rubyPlain(job.text);
    const q = alone ?? (await call(() => engine.query(plain, speaker)));
    if (!readingMatches(q, job.reading)) {
      cache[id] = { noun, accent: null };
      return null;
    }
    let accent: AccentInfo | null = null;
    let ga: VvQuery | null = null;
    if (noun) {
      const qGa = await call(() => engine.query(`${plain}が`, speaker));
      const a = gaAligned(job.reading, qGa) ? accentFromQueries(job.reading, q, qGa) : null;
      if (a) {
        accent = { ...a, withGa: true };
        ga = qGa;
      } else {
        const fromAlone = accentFromQueries(job.reading, q, null);
        if (fromAlone && fromAlone.drop > 0) accent = fromAlone;
      }
    } else {
      accent = accentFromQueries(job.reading, q, null);
    }
    cache[id] = { noun, accent };
    return ga;
  };

  /** Step 4: the 'pitch:' clip, synthesized from the same verified が query that set the accent. */
  const makePitch = async (job: AudioJob, wordId: string, qGa: VvQuery | null): Promise<void> => {
    const pitch = pitchJobFor(job);
    if (results.has(pitch.ref)) return;
    const pid = clipId(pitch);
    countPitch(pitch.ref);
    if (carry(pitch, pid)) return;
    let pending = generating.get(pid);
    if (!pending) {
      pending = (async (): Promise<Generated> => {
        const speaker = VOICES[pitch.voice].speaker;
        const q = qGa ?? (await call(() => engine.query(rubyPlain(pitch.text), speaker)));
        // The drill marks right what accent.json records, so the clip must carry exactly that accent. A query made
        // now for a cached accent can differ from the one that set it (another engine version).
        const recorded = cache[wordId]?.accent;
        const heard = gaAligned(job.reading, q) ? accentFromQueries(job.reading, q, q) : null;
        if (!heard || !recorded || heard.drop !== recorded.drop) {
          return { failure: { ref: pitch.ref, text: pitch.text, reading: pitch.reading, heard: [queryMoras(q)] } };
        }
        const wav = await call(() => engine.synthesize({ ...q, ...SYNTHESIS }, speaker));
        const file = clipFile(pid);
        const bytes = await store.put(file, wav);
        return { clip: { file, ms: wavDurationMs(wav), voice: pitch.voice, pack: pitch.pack, via: 'text' }, query: q, bytes };
      })();
      generating.set(pid, pending);
    }
    const started = performance.now();
    const out = await pending;
    if ('failure' in out) {
      // The cached accent's が query no longer lines up or gives another accent (a different engine?): forget the
      // accent, so accent.json and the pitch clips stay consistent, and measure again next run.
      delete cache[wordId];
      warnings.push(`${pitch.ref}: the が query no longer gives the recorded accent; accent dropped, no pitch clip`);
      return;
    }
    added(pitch, pid, out, performance.now() - started);
  };

  const processJob = async (job: AudioJob): Promise<void> => {
    const id = ids.get(job)!;
    const started = performance.now();
    let query: VvQuery | undefined;
    if (!results.has(job.ref)) {
      if (unreadable(job)) {
        fail(job, { ref: job.ref, text: job.text, reading: job.reading, heard: [], error: 'the reading still contains kanji' });
        return;
      }
      let pending = generating.get(id);
      if (!pending) {
        pending = generate(job, id);
        generating.set(id, pending);
      }
      const out = await pending;
      if ('failure' in out) {
        // The attempt may have been made for another ref with the same clip: report this one.
        fail(job, { ...out.failure, ref: job.ref, text: job.text, reading: job.reading });
        return;
      }
      query = out.query;
      added(job, id, out, performance.now() - started);
    }
    const entry = results.get(job.ref)!;
    if (!job.word || entry.clip.via !== 'text') return;
    if (!cachedAccent(job, id)) {
      const key = `${id}|${job.word.nounLike}`;
      let pending = measuring.get(key);
      if (!pending) {
        pending = measure(job, id, query);
        measuring.set(key, pending);
      }
      const ga = await pending;
      if (cache[id]?.accent?.withGa) await makePitch(job, id, ga);
    } else if (cache[id].accent?.withGa) {
      await makePitch(job, id, null);
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < work.length && !aborted) {
      const job = work[next++];
      try {
        await processJob(job);
      } catch (err) {
        if (err instanceof EngineDownError) {
          aborted = err.message;
          return;
        }
        fail(job, { ref: job.ref, text: job.text, reading: job.reading, heard: [], error: (err as Error).message });
      }
      done++;
      opts.onProgress?.({ done, total: work.length, generated: newClips, failed: failedCount, job });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));

  attachShared();
  for (const job of jobs) if (!results.has(job.ref) && !isSelected(job)) statsFor(job.ref).pending++;
  return finish();

  /**
   * A job whose clip was made for another ref (same voice, text and reading) gets it now, not only on the next run,
   * so two identical runs give identical manifests. So does its pitch clip when its accent is cached.
   */
  function attachShared(): void {
    const byId = new Map<string, AudioClip>();
    for (const e of results.values()) if (!byId.has(e.id)) byId.set(e.id, e.clip);
    const attach = (job: AudioJob, id: string): boolean => {
      const clip = byId.get(id);
      if (!clip || results.has(job.ref)) return false;
      results.set(job.ref, { job, id, clip: { ...clip, pack: job.pack } });
      statsFor(job.ref).reused++;
      return true;
    };
    for (const job of jobs) {
      const id = ids.get(job)!;
      if (!attach(job, id)) continue;
      if (job.word && byId.get(id)?.via === 'text' && cachedAccent(job, id)?.accent?.withGa) {
        const pitch = pitchJobFor(job);
        countPitch(pitch.ref);
        attach(pitch, clipId(pitch));
      }
    }
  }

  function entries(): ClipEntry[] {
    // Job order, so the manifest and its pack choices are deterministic whatever the worker interleaving.
    const order = new Map(jobs.map((j, i) => [j.ref, i]));
    const rank = (ref: string) => order.get(ref) ?? order.get(ref.slice('pitch:'.length)) ?? Infinity;
    return [...results.values()].sort((a, b) => rank(a.job.ref) - rank(b.job.ref) || (a.job.ref < b.job.ref ? -1 : 1));
  }

  function snapshot() {
    const list = entries();
    return {
      manifest: buildManifest(list, opts.engineLabel, now().toISOString()),
      accent: buildAccentFile(list, cache),
      accentCache: cache,
    };
  }

  function finish(): RunResult {
    const snap = snapshot();
    const manifest = keepGeneratedAt(snap.manifest, opts.previous);
    const { accent } = snap;
    // Keep cached accent only for the clips of current word jobs.
    const wordIds = new Set(jobs.filter((j) => j.word).map((j) => ids.get(j)!));
    const accentCache: AccentCache = {};
    for (const id of Object.keys(cache).sort()) if (wordIds.has(id)) accentCache[id] = cache[id];
    const missing = jobs.filter((j) => !results.has(j.ref)).length;
    return { manifest, accent, accentCache, failures, warnings, stats, missing, generatedByVoice, ...(aborted ? { aborted } : {}) };
  }
}
