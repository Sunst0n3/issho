// A small HTTP client for a local VOICEVOX engine (http://127.0.0.1:50021 by default).

import type { VvQuery } from '../../shared/voicevox.ts';

export const DEFAULT_ENGINE = 'http://127.0.0.1:50021';

/** What the generator needs from an engine; tests pass a fake. */
export interface Engine {
  query(text: string, speaker: number): Promise<VvQuery>;
  /** WAV bytes (16-bit PCM). */
  synthesize(q: VvQuery, speaker: number): Promise<Uint8Array>;
}

export class EngineError extends Error {}

/** Synthesis settings for every clip (the query's own values are replaced). */
export const SYNTHESIS = {
  speedScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  outputSamplingRate: 24000,
  outputStereo: false,
} as const;

const RETRIES = 3;

export class HttpEngine implements Engine {
  readonly base: string;
  readonly timeoutMs: number;

  constructor(base = DEFAULT_ENGINE, timeoutMs = 60_000) {
    this.base = base.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return res;
        const body = (await res.text()).slice(0, 200);
        // 4xx means the request itself is wrong: retrying will not help.
        if (res.status < 500) throw new EngineError(`${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status} ${body}`);
        last = new EngineError(`${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status} ${body}`);
      } catch (err) {
        if (err instanceof EngineError) throw err;
        last = err;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw last instanceof Error ? last : new EngineError(String(last));
  }

  async version(): Promise<string> {
    return (await (await this.request('/version')).json()) as string;
  }

  /** Style ids the engine offers. */
  async styleIds(): Promise<Set<number>> {
    const speakers = (await (await this.request('/speakers')).json()) as { styles: { id: number }[] }[];
    return new Set(speakers.flatMap((s) => s.styles.map((st) => st.id)));
  }

  async query(text: string, speaker: number): Promise<VvQuery> {
    const res = await this.request(`/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST' });
    return (await res.json()) as VvQuery;
  }

  async synthesize(q: VvQuery, speaker: number): Promise<Uint8Array> {
    const res = await this.request(`/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...q, ...SYNTHESIS }),
    });
    return new Uint8Array(await res.arrayBuffer());
  }
}
