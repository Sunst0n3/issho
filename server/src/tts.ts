// Server speech: a proxy to a VOICEVOX engine (docker-compose's optional `voicevox` service) for
// Japanese the pre-generated clips don't cover (chat lines, AI replies, words outside the clip
// scope). Each WAV is kept on disk under a hash of voice, engine version and text, so a phrase is
// synthesized once; the cache is pruned to TTS_CACHE_MB, least recently used first.
//
// Privacy: the text never appears in a file name, a log line or an error message here. The
// engine's own API takes it as a query parameter, but only on the private Docker network.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TTS_MAX_CHARS, type VoiceId } from '../../shared/api.ts';
import { readingMatches, rubyKana, rubyPlain, VOICES, type VvQuery } from '../../shared/voicevox.ts';

export interface TtsService {
  /** Last health check (GET /version, refreshed in the background at most every 60 s). Never blocks. */
  available(): boolean;
  /** WAV for the text. Throws TtsError(503, 'tts_unavailable') when the engine fails, TtsError(400, 'bad_text'). */
  synthesize(text: string, voice: VoiceId): Promise<{ wav: Buffer; cached: boolean }>;
  close(): void;
}

/** The VOICEVOX service, plus cache upkeep for tests and maintenance. */
export interface VoicevoxTts extends TtsService {
  /** Deletes the least recently used WAVs while the cache is over its cap. Returns how many it deleted. */
  prune(): Promise<number>;
}

export class TtsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    // Only the code: never the text that was being synthesized.
    super(code);
    this.name = 'TtsError';
    this.status = status;
    this.code = code;
  }
}

/** Engine calls give up after this long (one synthesis of a long sentence takes 1–3 s on a CPU). */
export const ENGINE_TIMEOUT_MS = 15_000;
/** available() refreshes its answer in the background at most this often. */
export const HEALTH_INTERVAL_MS = 60_000;
/** The cache is pruned at most this often (after a write). */
export const PRUNE_INTERVAL_MS = 60 * 60_000;
const MB = 1024 * 1024;

const unavailable = () => new TtsError(503, 'tts_unavailable');

export function createVoicevoxTts(opts: {
  baseUrl: string;            // VOICEVOX_URL, e.g. http://voicevox:50021
  cacheDir: string;           // DATA_DIR/tts
  maxCacheMb: number;         // TTS_CACHE_MB, default 300
  fetch?: typeof fetch;
  now?: () => Date;
}): VoicevoxTts {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const maxBytes = opts.maxCacheMb * MB;

  let up = false;
  /** Engine version from GET /version, part of every cache key (a new engine may read differently). */
  let engineVersion: string | null = null;
  let checkedAt = -Infinity;
  let checking: Promise<void> | null = null;
  let lastPruneAt = -Infinity;
  let pruning: Promise<number> | null = null;
  let closed = false;
  /** One synthesis at a time: the engine runs on the CPU, and parallel requests only slow each other. */
  let queue: Promise<unknown> = Promise.resolve();
  /** The same text asked twice at once is synthesized once. */
  const inFlight = new Map<string, Promise<Buffer>>();
  let dirReady: Promise<unknown> | null = null;

  async function engine(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${pathAndQuery}`, { ...init, signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS) });
    } catch {
      // The error (and its cause) can carry the request URL, which holds the text: drop it.
      throw unavailable();
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw unavailable();
    }
    return res;
  }

  function check(): Promise<void> {
    checking ??= (async () => {
      try {
        const res = await engine('/version');
        const version = (await res.json().catch(() => null)) as unknown;
        engineVersion = typeof version === 'string' && version ? version : 'unknown';
        up = true;
      } catch {
        up = false;
      } finally {
        checkedAt = now().getTime();
      }
    })().finally(() => { checking = null; });
    return checking;
  }

  const stale = () => now().getTime() - checkedAt >= HEALTH_INTERVAL_MS;

  async function query(text: string, speaker: number): Promise<VvQuery> {
    const res = await engine(`/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST' });
    try {
      return (await res.json()) as VvQuery;
    } catch {
      throw unavailable();
    }
  }

  /** audio_query of the written text; when it has ruby and the engine misread it, of the reading instead. */
  async function bestQuery(text: string, speaker: number): Promise<VvQuery> {
    const plain = rubyPlain(text);
    const reading = rubyKana(text);
    const q = await query(plain, speaker);
    if (reading === plain || readingMatches(q, reading)) return q;
    return query(reading, speaker);
  }

  async function synthesizeWav(text: string, voice: VoiceId): Promise<Buffer> {
    const speaker = VOICES[voice].speaker;
    const q = await bestQuery(text, speaker);
    const res = await engine(`/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/wav' },
      body: JSON.stringify(q),
    });
    const wav = Buffer.from(await res.arrayBuffer().catch(() => { throw unavailable(); }));
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') throw unavailable();
    return wav;
  }

  async function writeAtomically(file: string, data: Buffer): Promise<void> {
    dirReady ??= mkdir(opts.cacheDir, { recursive: true });
    await dirReady;
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async function prune(): Promise<number> {
    pruning ??= (async () => {
      lastPruneAt = now().getTime();
      const names = await readdir(opts.cacheDir).catch(() => [] as string[]);
      const files: { file: string; size: number; mtimeMs: number }[] = [];
      for (const name of names) {
        if (!name.endsWith('.wav')) continue;
        const file = path.join(opts.cacheDir, name);
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
      }
      let total = files.reduce((sum, f) => sum + f.size, 0);
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let removed = 0;
      for (const f of files) {
        if (total <= maxBytes) break;
        await unlink(f.file).catch(() => {});
        total -= f.size;
        removed++;
      }
      return removed;
    })().finally(() => { pruning = null; });
    return pruning;
  }

  function maybePrune(): void {
    if (closed || now().getTime() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    void prune().catch(() => {});
  }

  function cacheFile(text: string, voice: VoiceId, version: string): string {
    const key = createHash('sha256').update(`${voice}|${version}|${text}`).digest('hex');
    return path.join(opts.cacheDir, `${key}.wav`);
  }

  async function readCached(file: string): Promise<Buffer | null> {
    try {
      const wav = await readFile(file);
      // Touch it: pruning drops the least recently used first.
      const at = now();
      await utimes(file, at, at).catch(() => {});
      return wav;
    } catch {
      return null;
    }
  }

  // Know the engine (and its version) before the first request comes in.
  void check();

  return {
    available() {
      if (!closed && stale() && !checking) void check();
      return up;
    },

    async synthesize(rawText, voice) {
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text || text.length > TTS_MAX_CHARS || (voice !== 'f' && voice !== 'm')) throw new TtsError(400, 'bad_text');
      if (closed) throw unavailable();

      if (checking) await checking;
      else if (engineVersion === null || (!up && stale())) await check();
      if (engineVersion !== null) {
        const cached = await readCached(cacheFile(text, voice, engineVersion));
        if (cached) return { wav: cached, cached: true };
      }
      if (!up || engineVersion === null) throw unavailable();

      const file = cacheFile(text, voice, engineVersion);
      let pending = inFlight.get(file);
      if (!pending) {
        const job = queue.then(async () => {
          // The engine failed while this waited (a hung engine costs 15 s per call): fail now, as
          // a new request would, rather than hold up the queue until the next health check.
          if (!up) throw unavailable();
          try {
            const wav = await synthesizeWav(text, voice);
            await writeAtomically(file, wav).catch(() => {
              // A full or read-only disk only costs the cache.
            });
            return wav;
          } catch (error) {
            if (error instanceof TtsError && error.status === 503) {
              up = false;
              checkedAt = now().getTime();
            }
            throw error;
          }
        });
        pending = job.finally(() => inFlight.delete(file));
        queue = job.catch(() => {});
        inFlight.set(file, pending);
      }
      const wav = await pending;
      maybePrune();
      return { wav, cached: false };
    },

    prune,

    close() {
      closed = true;
    },
  };
}
