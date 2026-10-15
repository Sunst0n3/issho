import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { HealthResponse, VoiceId } from '../../shared/api.ts';
import { toKatakana, type VvQuery } from '../../shared/voicevox.ts';
import { createVoicevoxTts, HEALTH_INTERVAL_MS, PRUNE_INTERVAL_MS, TtsError, type TtsService, type VoicevoxTts } from '../src/tts.ts';
import { bearer, createTestServer, tick, type TestServer } from './helpers.ts';

/** How the fake engine hears kanji words (as VOICEVOX would, katakana). Anything else is read as written. */
const ENGINE_READINGS: Record<string, string> = {
  '今日は': 'キョウワ',
  '箸': 'ハシ',
  '雨が降る': 'アメガフル',
};

function wavOf(label: string): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32), Buffer.from(label)]);
}

/** A VOICEVOX engine in memory: GET /version, POST /audio_query, POST /synthesis. */
function fakeEngine() {
  const calls: string[] = [];
  const queries: { speaker: string; text: string }[] = [];
  const synthesized: { speaker: string; moras: string }[] = [];
  let down = false;
  let active = 0;
  let maxActive = 0;
  let synthesisDelayMs = 0;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (down) throw new TypeError(`fetch failed: ${url.href}`);
    if (url.pathname === '/version') return json('0.25.2');
    if (url.pathname === '/audio_query') {
      const text = url.searchParams.get('text') ?? '';
      queries.push({ speaker: url.searchParams.get('speaker') ?? '', text });
      const heard = ENGINE_READINGS[text] ?? toKatakana(text);
      const q: VvQuery = {
        accent_phrases: [{
          moras: Array.from(heard, (ch) => ({ text: ch, vowel: 'a', vowel_length: 0.1, pitch: 5 })),
          accent: 1,
          pause_mora: null,
        }],
        speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
        prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000, outputStereo: false,
      };
      return json(q);
    }
    if (url.pathname === '/synthesis') {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (synthesisDelayMs) await tick(synthesisDelayMs);
        const q = JSON.parse(String(init?.body)) as VvQuery;
        const moras = q.accent_phrases.map((p) => p.moras.map((m) => m.text).join('')).join('');
        synthesized.push({ speaker: url.searchParams.get('speaker') ?? '', moras });
        return new Response(new Uint8Array(wavOf(moras)), { status: 200, headers: { 'content-type': 'audio/wav' } });
      } finally {
        active--;
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    queries,
    synthesized,
    get maxActive() { return maxActive; },
    setDown(value: boolean) { down = value; },
    setSynthesisDelay(ms: number) { synthesisDelayMs = ms; },
  };
}

describe('VOICEVOX speech service', () => {
  let cacheDir: string;
  let engine: ReturnType<typeof fakeEngine>;
  let clock: number;
  let tts: VoicevoxTts;

  const create = (maxCacheMb = 300) =>
    createVoicevoxTts({ baseUrl: 'http://voicevox:50021/', cacheDir, maxCacheMb, fetch: engine.fetch, now: () => new Date(clock) });

  beforeEach(async () => {
    cacheDir = path.join(await mkdtemp(path.join(tmpdir(), 'issho-tts-')), 'tts');
    engine = fakeEngine();
    clock = Date.parse('2026-10-15T09:00:00Z');
    tts = create();
  });
  afterEach(async () => {
    tts.close();
    await rm(path.dirname(cacheDir), { recursive: true, force: true });
  });

  it('checks the engine at start, then synthesizes and keeps the WAV under a hash', async () => {
    await tick();
    assert.equal(tts.available(), true);
    const first = await tts.synthesize('雨が降る', 'f');
    assert.equal(first.cached, false);
    assert.equal(first.wav.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(engine.queries, [{ speaker: '30', text: '雨が降る' }]);
    assert.deepEqual(engine.synthesized, [{ speaker: '30', moras: 'アメガフル' }]);

    const files = await readdir(cacheDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{64}\.wav$/);
  });

  it('answers a repeat from the cache without calling the engine', async () => {
    await tts.synthesize('{箸|はし}', 'f');
    const calls = engine.calls.length;
    const again = await tts.synthesize('{箸|はし}', 'f');
    assert.equal(again.cached, true);
    assert.equal(engine.calls.length, calls);
    // Another voice is another recording.
    assert.equal((await tts.synthesize('{箸|はし}', 'm')).cached, false);
    assert.equal(engine.synthesized.at(-1)?.speaker, '13');
  });

  it('queries again with the reading when the engine misreads ruby text', async () => {
    const { cached } = await tts.synthesize('{今日|こんにち}は', 'f');
    assert.equal(cached, false);
    // 今日は read as キョウワ does not match こんにちは: the second query is the reading itself.
    assert.deepEqual(engine.queries.map((q) => q.text), ['今日は', 'こんにちは']);
    assert.deepEqual(engine.synthesized.map((s) => s.moras), ['コンニチハ']);
  });

  it('keeps the written text when the engine reads it as the ruby says', async () => {
    await tts.synthesize('{箸|はし}', 'f');
    assert.deepEqual(engine.queries.map((q) => q.text), ['箸']);
  });

  it('reports an engine that is down: 503 tts_unavailable and available() false, until it is back', async () => {
    engine.setDown(true);
    const down = create();
    await tick();
    assert.equal(down.available(), false);
    await assert.rejects(down.synthesize('こんにちは', 'f'), (e: unknown) => {
      assert.ok(e instanceof TtsError);
      assert.equal(e.status, 503);
      assert.equal(e.code, 'tts_unavailable');
      assert.doesNotMatch(e.message, /こんにちは/);
      return true;
    });

    engine.setDown(false);
    assert.equal(down.available(), false, 'no new check before the interval');
    clock += HEALTH_INTERVAL_MS;
    assert.equal(down.available(), false, 'the refresh runs in the background');
    await tick();
    assert.equal(down.available(), true);
    assert.equal((await down.synthesize('こんにちは', 'f')).cached, false);
    down.close();
  });

  it('marks the engine down when a synthesis fails', async () => {
    await tick();
    assert.equal(tts.available(), true);
    engine.setDown(true);
    await assert.rejects(tts.synthesize('はい', 'f'), { status: 503, code: 'tts_unavailable' });
    assert.equal(tts.available(), false);
  });

  it('still answers from the cache while the engine is down', async () => {
    await tts.synthesize('はい', 'f');
    engine.setDown(true);
    assert.equal((await tts.synthesize('はい', 'f')).cached, true);
  });

  it('refuses empty or over-long text', async () => {
    for (const text of ['', '   ', 'あ'.repeat(201)]) {
      await assert.rejects(tts.synthesize(text, 'f'), { status: 400, code: 'bad_text' });
    }
    await assert.rejects(tts.synthesize('はい', 'x' as VoiceId), { status: 400, code: 'bad_text' });
    assert.equal((await tts.synthesize('あ'.repeat(200), 'f')).cached, false);
  });

  it('synthesizes one text at a time, and the same text once', async () => {
    engine.setSynthesisDelay(15);
    const results = await Promise.all([
      tts.synthesize('いち', 'f'),
      tts.synthesize('に', 'f'),
      tts.synthesize('さん', 'f'),
      tts.synthesize('いち', 'f'),
    ]);
    assert.equal(engine.maxActive, 1);
    // Each text once; the order is the order the cache lookups finish, which the file system decides.
    assert.deepEqual(engine.synthesized.map((s) => s.moras).sort(), ['イチ', 'サン', 'ニ'].sort());
    assert.deepEqual(results[0].wav, results[3].wav);
  });

  it('fails the requests still queued once the engine has failed, without waiting on it for each', async () => {
    await tick();
    engine.setSynthesisDelay(60);
    const results = Promise.allSettled([
      tts.synthesize('いち', 'f'),
      tts.synthesize('に', 'f'),
      tts.synthesize('さん', 'f'),
    ]);
    while (!engine.calls.includes('POST /synthesis')) await tick(1);
    // The first is being synthesized and the other two wait in the queue when the engine goes away.
    await tick(20);
    engine.setDown(true);
    const callsBefore = engine.calls.length;

    // (Which text was queued first depends on the order the cache lookups finish.)
    const settled = await results;
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = settled.filter((r) => r.status === 'rejected');
    assert.equal(failed.length, 2);
    for (const r of failed) assert.ok(r.reason instanceof TtsError && r.reason.status === 503);
    // Only the second in the queue tried the engine; the third failed at once.
    assert.deepEqual(engine.calls.slice(callsBefore), ['POST /audio_query']);
  });

  it('prunes the least recently used WAVs while the cache is over its cap', async () => {
    // 1 KB cap; three 600-byte files of different ages.
    const small = create(1 / 1024);
    const file = (name: string) => path.join(cacheDir, `${name.repeat(64)}.wav`);
    await tts.synthesize('はい', 'f'); // creates the folder
    for (const name of await readdir(cacheDir)) await rm(path.join(cacheDir, name));
    const ages: [string, number][] = [['a', 3], ['b', 1], ['c', 2]];
    for (const [name, hoursAgo] of ages) {
      await writeFile(file(name), Buffer.alloc(600));
      const at = new Date(clock - hoursAgo * 3_600_000);
      await utimes(file(name), at, at);
    }
    await writeFile(path.join(cacheDir, 'notes.txt'), 'kept');

    assert.equal(await small.prune(), 2);
    assert.deepEqual((await readdir(cacheDir)).sort(), [`${'b'.repeat(64)}.wav`, 'notes.txt']);
    small.close();
  });

  it('touches a WAV it serves, so pruning keeps what is still used', async () => {
    await tts.synthesize('はい', 'f');
    const [name] = await readdir(cacheDir);
    const old = new Date(clock - 5 * 3_600_000);
    await utimes(path.join(cacheDir, name), old, old);
    await tts.synthesize('はい', 'f');
    assert.equal((await stat(path.join(cacheDir, name))).mtimeMs, clock);
  });

  it('prunes after a write at most once an hour', async () => {
    const small = create(1 / 1024 / 1024); // a 1-byte cap: every prune empties the cache
    await small.synthesize('いち', 'f');
    await tick();
    assert.deepEqual(await readdir(cacheDir), [], 'the first write prunes');
    await small.synthesize('に', 'f');
    await tick();
    assert.equal((await readdir(cacheDir)).length, 1, 'not again within the hour');
    clock += PRUNE_INTERVAL_MS;
    await small.synthesize('さん', 'f');
    await tick();
    assert.deepEqual(await readdir(cacheDir), []);
    small.close();
  });
});

describe('POST /api/tts', () => {
  let server: TestServer;
  let token: string;
  let synthesized: { text: string; voice: VoiceId }[];
  let fail: TtsError | null;
  const logLines: string[] = [];

  const stub: TtsService = {
    available: () => true,
    async synthesize(text, voice) {
      if (fail) throw fail;
      synthesized.push({ text, voice });
      return { wav: wavOf(text), cached: synthesized.length > 1 };
    },
    close() {},
  };

  before(async () => {
    server = await createTestServer({ tts: stub, logLines });
    ({ deviceToken: token } = await server.register('Ken'));
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    synthesized = [];
    fail = null;
    logLines.length = 0;
  });

  const speak = (payload: unknown, auth = token) =>
    server.app.inject({ method: 'POST', url: '/api/tts', headers: auth ? bearer(auth) : {}, payload: payload as object });

  it('answers a JSON body with a private, cacheable WAV', async () => {
    const res = await speak({ text: '  {今日|きょう}はいい{天気|てんき}ですね  ', voice: 'm' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'audio/wav');
    assert.equal(res.headers['cache-control'], 'private, max-age=604800');
    assert.equal(res.rawPayload.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(synthesized, [{ text: '{今日|きょう}はいい{天気|てんき}ですね', voice: 'm' }]);
  });

  it("uses voice 'f' by default", async () => {
    await speak({ text: 'はい' });
    assert.deepEqual(synthesized, [{ text: 'はい', voice: 'f' }]);
  });

  it('refuses text over 200 characters, empty text and an unknown voice', async () => {
    for (const payload of [{ text: 'あ'.repeat(201) }, { text: '   ' }, {}, { text: 'はい', voice: 'x' }]) {
      const res = await speak(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal((await speak({ text: 'あ'.repeat(200) })).statusCode, 200);
  });

  it('needs a paired device', async () => {
    assert.equal((await speak({ text: 'はい' }, '')).statusCode, 401);
  });

  it('maps an engine failure to 503 tts_unavailable', async () => {
    fail = new TtsError(503, 'tts_unavailable');
    const res = await speak({ text: 'はい' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'tts_unavailable' });
  });

  it('never writes the text to the request log, even when the engine fails', async () => {
    const text = '{秘密|ひみつ}のメッセージ';
    await speak({ text });
    fail = new TtsError(503, 'tts_unavailable');
    await speak({ text });
    await tick();
    const log = logLines.join('\n');
    assert.match(log, /\/api\/tts/, 'the request itself is logged');
    assert.match(log, /tts_unavailable/, 'the failure is logged by its code');
    for (const fragment of ['秘密', 'ひみつ', 'メッセージ', encodeURIComponent('秘密')]) {
      assert.ok(!log.includes(fragment), `log contains ${fragment}`);
    }
  });

  it('limits each member to 120 calls a minute', async () => {
    const other = await createTestServer({ tts: stub });
    const { deviceToken } = await other.register('Aki');
    try {
      for (let i = 0; i < 120; i++) {
        const res = await other.app.inject({ method: 'POST', url: '/api/tts', headers: bearer(deviceToken), payload: { text: 'はい' } });
        assert.equal(res.statusCode, 200, `call ${i + 1}`);
      }
      const res = await other.app.inject({ method: 'POST', url: '/api/tts', headers: bearer(deviceToken), payload: { text: 'はい' } });
      assert.equal(res.statusCode, 429);
      assert.deepEqual(res.json(), { error: 'rate_limited' });
      assert.ok(Number(res.headers['retry-after']) > 0);
    } finally {
      await other.close();
    }
  });
});

describe('without a speech engine', () => {
  let server: TestServer;
  before(async () => {
    server = await createTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('answers 503 tts_unavailable and health says ttsEnabled false', async () => {
    const { deviceToken } = await server.register('Ken');
    const res = await server.app.inject({ method: 'POST', url: '/api/tts', headers: bearer(deviceToken), payload: { text: 'はい' } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'tts_unavailable' });
    const health = (await server.app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
    assert.equal(health.ttsEnabled, false);
  });
});

describe('health with a speech engine', () => {
  it('reports ttsEnabled from the engine check', async () => {
    let up = true;
    const service: TtsService = { available: () => up, synthesize: async () => ({ wav: wavOf('x'), cached: false }), close() {} };
    const server = await createTestServer({ tts: service });
    try {
      const health = async () => (await server.app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>().ttsEnabled;
      assert.equal(await health(), true);
      up = false;
      assert.equal(await health(), false);
    } finally {
      await server.close();
    }
  });
});
