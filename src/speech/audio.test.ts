import { act, renderHook } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '../../shared/api.ts';
import { clipTextKey } from '../../shared/voicevox.ts';
import { db, updateSettings } from '../lib/db.ts';
import type { AudioClip, AudioManifest } from '../lib/types.ts';
import {
  getDefaultAudioRate,
  hasClip,
  installAudioUnlock,
  packsFor,
  play,
  prefetchPacks,
  resetAudio,
  setDefaultAudioRate,
  stopAudio,
  TTS_CACHE,
  TTS_CACHE_MAX_BYTES,
  TTS_INDEX_KEY,
  usePlayback,
} from './audio.ts';

const fixtures = vi.hoisted(() => ({ manifest: null as unknown as AudioManifest }));

vi.mock('../lib/data.ts', () => ({
  EMPTY_MANIFEST: { version: 1, generatedAt: '', engine: '', credits: [], clips: {}, byRef: {}, byText: {} },
  loadAudioManifest: async () => fixtures.manifest,
  audioUrl: (file: string) => `/audio/${file}`,
}));

const device = vi.hoisted(() => ({
  available: true,
  spoken: [] as { text: string; rate?: number }[],
}));
vi.mock('./tts.ts', () => ({
  speak: vi.fn(async (text: string, opts: { rate?: number } = {}) => { device.spoken.push({ text, rate: opts.rate }); }),
  stopSpeaking: vi.fn(),
  ttsAvailable: () => device.available,
}));

// ---- Fixtures ------------------------------------------------------------------

const clip = (file: string, patch: Partial<AudioClip> = {}): AudioClip => ({ file, ms: 800, voice: 'f', pack: 'u01', via: 'text', ...patch });

function buildManifest(): AudioManifest {
  const clips: Record<string, AudioClip> = {
    taberu: clip('a1/taberu.m4a'),
    hashiBridge: clip('b2/hashi-bridge.m4a', { pack: 'c01' }),
    kyouBridge: clip('b3/kyou-bridge.m4a', { pack: 'c01' }),
    story: clip('c3/story.m4a', { ms: 2600, phrases: [100, 900, 1700], pack: 'u02' }),
    kanaA: clip('d4/kana-a.m4a', { pack: 'kana', ms: 300 }),
    u01b: clip('e5/u01b.m4a'),
    u01c: clip('e6/u01c.m4a'),
    misc: clip('f7/misc.m4a', { pack: 'misc' }),
  };
  return {
    version: 1,
    generatedAt: '2026-10-15T00:00:00Z',
    engine: 'VOICEVOX 0.25.2',
    credits: ['VOICEVOX:No.7', 'VOICEVOX:青山龍星'],
    clips,
    byRef: { 'core:cw-0001': 'taberu', 'story:st-1#0': 'story', 'kana:あ': 'kanaA' },
    byText: {
      [clipTextKey('f', '{食べる|たべる}')]: 'taberu',
      // Unambiguous plain text: also indexed without its reading.
      'f|食べる|': 'taberu',
      // Two readings of 橋 (homographs): no plain-only key.
      [clipTextKey('f', '{橋|はし}')]: 'hashiBridge',
      [clipTextKey('f', '{橋|きょう}')]: 'kyouBridge',
    },
  };
}

/** Cache Storage in memory (jsdom has none). */
class MemoryCache {
  readonly entries = new Map<string, Response>();
  private key(input: RequestInfo | URL): string {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost:3000').href;
  }
  async match(input: RequestInfo | URL) { return this.entries.get(this.key(input))?.clone(); }
  async put(input: RequestInfo | URL, res: Response) {
    this.entries.set(this.key(input), new Response(await res.arrayBuffer(), { headers: res.headers }));
  }
  async delete(input: RequestInfo | URL) { return this.entries.delete(this.key(input)); }
  async keys() { return [...this.entries.keys()].map((url) => ({ url }) as Request); }
  paths() { return [...this.entries.keys()].map((url) => new URL(url).pathname); }
}

function installCaches() {
  const stores = new Map<string, MemoryCache>();
  const storage = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name)!;
    },
  };
  vi.stubGlobal('caches', storage);
  return (name: string) => stores.get(name) ?? new MemoryCache();
}

// ---- Network -----------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let health: HealthResponse;
let ttsAnswer: (text: string) => Response;
let clipAnswer: (path: string) => Response | Promise<Response>;
const requests: string[] = [];
const ttsBodies: { text: string; voice?: string }[] = [];

const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input), 'http://localhost:3000');
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/api/health') return json(health);
  if (url.pathname === '/api/tts') {
    const body = JSON.parse(String(init?.body)) as { text: string; voice?: string };
    ttsBodies.push(body);
    return ttsAnswer(body.text);
  }
  if (url.pathname.startsWith('/audio/')) return clipAnswer(url.pathname);
  return json({ error: 'not_found' }, 404);
});

const wav = (bytes = 64) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
const ttsPosts = () => requests.filter((r) => r === 'POST /api/tts').length;

let online = true;

beforeEach(async () => {
  resetAudio();
  fixtures.manifest = buildManifest();
  device.available = true;
  device.spoken = [];
  requests.length = 0;
  ttsBodies.length = 0;
  health = { ok: true, version: '0.2.0', aiEnabled: false, ttsEnabled: true };
  ttsAnswer = () => wav();
  clipAnswer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  online = true;
  Object.defineProperty(navigator, 'onLine', { get: () => online, configurable: true });
  // jsdom's crypto has no subtle; browsers on https have it.
  if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'tok', memberId: 'me' });
});

afterEach(() => {
  resetAudio();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Keeps the shared element "playing" until the test ends it. Returns the elements play() was called on. */
function holdPlayback() {
  const elements: HTMLMediaElement[] = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    elements.push(this);
    return Promise.resolve();
  });
  return elements;
}

// ---- Tests ------------------------------------------------------------------------------

describe('play: resolution order', () => {
  it('plays a clip by ref, fetched from /audio, without the server or the device', async () => {
    await expect(play({ ref: 'core:cw-0001' })).resolves.toMatchObject({ via: 'clip', interrupted: false });
    expect(requests).toEqual(['GET /audio/a1/taberu.m4a']);
    expect(device.spoken).toEqual([]);
  });

  it('finds a clip by text: any ruby markup of the same reading, and plain text when unambiguous', async () => {
    for (const text of ['{食|た}べる', '{食べる|たべる}', '食べる']) {
      requests.length = 0;
      await expect(play({ text })).resolves.toMatchObject({ via: 'clip' });
      expect(requests, text).toEqual(['GET /audio/a1/taberu.m4a']);
    }
  });

  it('never plays a clip of another reading for a homograph', async () => {
    await play({ text: '{橋|はし}' });
    expect(requests).toEqual(['GET /audio/b2/hashi-bridge.m4a']);
    requests.length = 0;
    await play({ text: '{橋|きょう}' });
    expect(requests).toEqual(['GET /audio/b3/kyou-bridge.m4a']);

    // Plain 橋 is ambiguous: no clip, so the server reads it.
    requests.length = 0;
    await expect(play({ text: '橋' })).resolves.toMatchObject({ via: 'server' });
    expect(requests).toEqual(['GET /api/health', 'POST /api/tts']);
    expect(ttsBodies).toEqual([{ text: '橋', voice: 'f' }]);
  });

  it('goes to the server when paired, the server has an engine and the phone is online', async () => {
    await expect(play({ text: 'まいにちべんきょうします', voice: 'm' })).resolves.toMatchObject({ via: 'server' });
    expect(ttsBodies).toEqual([{ text: 'まいにちべんきょうします', voice: 'm' }]);
    expect(device.spoken).toEqual([]);
  });

  it('uses the device voice when the server cannot help', async () => {
    health.ttsEnabled = false;
    await expect(play({ text: 'こんにちは' })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(0);

    resetAudio();
    health.ttsEnabled = true;
    online = false;
    await expect(play({ text: 'こんにちは' })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(0);

    online = true;
    await updateSettings({ deviceToken: undefined });
    await expect(play({ text: 'こんにちは' })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(0);
    expect(device.spoken.map((s) => s.text)).toEqual(['こんにちは', 'こんにちは', 'こんにちは']);
  });

  it('reads text the server would refuse (over 200 characters) with the device voice', async () => {
    const long = 'あ'.repeat(201);
    await expect(play({ text: long })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(0);
  });

  it("never reads a story's phrase marks aloud on the device", async () => {
    await updateSettings({ deviceToken: undefined });
    await play({ text: '{今日|きょう}は／いい{天気|てんき}' });
    expect(device.spoken.at(-1)?.text).toBe('{今日|きょう}はいい{天気|てんき}');
  });

  it("is 'none' with nothing to play", async () => {
    await updateSettings({ deviceToken: undefined });
    device.available = false;
    await expect(play({ text: 'こんにちは' })).resolves.toMatchObject({ via: 'none', interrupted: false });
    device.available = true;
    // A ref without a clip and without fallback text.
    await expect(play({ ref: 'core:cw-9999' })).resolves.toMatchObject({ via: 'none' });
    expect(device.spoken).toEqual([]);
  });

  it('synthesizes the fallback text of a ref without a clip', async () => {
    await expect(play({ ref: 'word:1234567' }, { fallbackText: '{図書館|としょかん}' })).resolves.toMatchObject({ via: 'server' });
    expect(ttsBodies).toEqual([{ text: '{図書館|としょかん}', voice: 'f' }]);
    // …and plays a clip when the fallback text has one.
    requests.length = 0;
    await expect(play({ ref: 'word:7654321' }, { fallbackText: '{食|た}べる' })).resolves.toMatchObject({ via: 'clip' });
    expect(requests).toEqual(['GET /audio/a1/taberu.m4a']);
  });

  it('falls through to the server when a clip cannot be fetched (offline and not cached)', async () => {
    clipAnswer = () => { throw new TypeError('Failed to fetch'); };
    await expect(play({ ref: 'core:cw-0001' }, { fallbackText: '{食|た}べる' })).resolves.toMatchObject({ via: 'server' });
  });

  it("never takes the app's index.html for a missing clip, nor caches it", async () => {
    // Vite's dev and preview servers answer a missing file with index.html and a 200.
    const cache = installCaches();
    clipAnswer = () => new Response('<!doctype html><title>Issho</title>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    await expect(play({ ref: 'core:cw-0001' }, { fallbackText: '{食|た}べる' })).resolves.toMatchObject({ via: 'server' });
    expect(cache('issho-audio-v1').paths()).toEqual([]);
  });
});

describe('server speech', () => {
  it('skips the server for 5 minutes after a 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T10:00:00'));
    ttsAnswer = () => json({ error: 'tts_unavailable' }, 503);
    await expect(play({ text: 'いち' })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(1);

    vi.setSystemTime(new Date('2026-10-15T10:04:59'));
    await expect(play({ text: 'に' })).resolves.toMatchObject({ via: 'device' });
    expect(ttsPosts()).toBe(1);

    ttsAnswer = () => wav();
    vi.setSystemTime(new Date('2026-10-15T10:05:01'));
    await expect(play({ text: 'さん' })).resolves.toMatchObject({ via: 'server' });
    expect(ttsPosts()).toBe(2);
  });

  it('lets the device voice take a rate-limited line without giving up on the server', async () => {
    ttsAnswer = () => json({ error: 'rate_limited' }, 429);
    await expect(play({ text: 'いち' })).resolves.toMatchObject({ via: 'device' });
    ttsAnswer = () => wav();
    await expect(play({ text: 'に' })).resolves.toMatchObject({ via: 'server' });
    expect(ttsPosts()).toBe(2);
  });

  it('caches WAVs under a hash of the text, never the text, and plays them again offline', async () => {
    const cache = installCaches();
    await play({ text: '{秘密|ひみつ}のはなし' });
    const [key] = cache(TTS_CACHE).paths();
    expect(key).toMatch(/^\/__tts\/f\/[0-9a-f]{64}$/);
    expect(localStorage.getItem(TTS_INDEX_KEY)).not.toContain('ひみつ');

    online = false;
    await expect(play({ text: '{秘密|ひみつ}のはなし' })).resolves.toMatchObject({ via: 'server' });
    expect(ttsPosts()).toBe(1);
  });

  it('keeps the TTS cache at 20 MB or less, dropping the least recently used first', async () => {
    const cache = installCaches();
    const eightMb = 8 * 1024 * 1024;
    ttsAnswer = () => wav(eightMb);
    await play({ text: 'いち' });
    await play({ text: 'に' });
    // Hearing いち again (from the cache) makes に the oldest.
    await play({ text: 'いち' });
    expect(ttsPosts()).toBe(2);
    await play({ text: 'さん' });

    const index = JSON.parse(localStorage.getItem(TTS_INDEX_KEY)!) as [string, number, number][];
    const total = index.reduce((sum, [, bytes]) => sum + bytes, 0);
    expect(total).toBeLessThanOrEqual(TTS_CACHE_MAX_BYTES);
    expect(index).toHaveLength(2);
    expect(cache(TTS_CACHE).paths().sort()).toEqual(index.map(([k]) => k).sort());

    // に was dropped: it is fetched again; いち is still cached.
    await play({ text: 'いち' });
    expect(ttsPosts()).toBe(3);
    await play({ text: 'に' });
    expect(ttsPosts()).toBe(4);
  });

  it('rebuilds a lost index from the cache on the next write', async () => {
    const cache = installCaches();
    await play({ text: 'いち' });
    localStorage.removeItem(TTS_INDEX_KEY);
    await play({ text: 'に' });
    const index = JSON.parse(localStorage.getItem(TTS_INDEX_KEY)!) as [string, number, number][];
    expect(index.map(([k]) => k).sort()).toEqual(cache(TTS_CACHE).paths().sort());
    expect(index).toHaveLength(2);
  });
});

describe('rate', () => {
  it('is 0.85 up to course day 90, then 1, and Settings.audioRate wins', async () => {
    expect(getDefaultAudioRate()).toBe(0.85);
    setDefaultAudioRate(90);
    expect(getDefaultAudioRate()).toBe(0.85);
    setDefaultAudioRate(91);
    expect(getDefaultAudioRate()).toBe(1);
    setDefaultAudioRate(10, 1.2);
    expect(getDefaultAudioRate()).toBe(1.2);
    setDefaultAudioRate(10, 9);
    expect(getDefaultAudioRate()).toBe(0.85);
  });

  it('plays clips and device speech at the default rate unless told otherwise', async () => {
    const elements = holdPlayback();
    setDefaultAudioRate(30);
    const pending = play({ ref: 'core:cw-0001' });
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    expect(elements[0].playbackRate).toBe(0.85);
    expect(elements[0].defaultPlaybackRate).toBe(0.85);
    expect((elements[0] as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch).toBe(true);
    elements[0].dispatchEvent(new Event('ended'));
    await pending;

    await updateSettings({ deviceToken: undefined });
    await play({ text: 'こんにちは' }, { rate: 1.1 });
    expect(device.spoken.at(-1)).toEqual({ text: 'こんにちは', rate: 1.1 });
  });

  it('follows Settings.audioRate once the app has started', async () => {
    const stop = installAudioUnlock();
    await updateSettings({ audioRate: 0.7 });
    await vi.waitFor(() => expect(getDefaultAudioRate()).toBe(0.7));
    stop();
  });
});

describe('story phrases', () => {
  it('calls onPhrase in order as playback reaches each offset', async () => {
    const elements = holdPlayback();
    const seen: number[] = [];
    const pending = play({ ref: 'story:st-1#0' }, { onPhrase: (i) => seen.push(i) });
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    const el = elements[0];
    const at = (seconds: number) => {
      el.currentTime = seconds;
      el.dispatchEvent(new Event('timeupdate'));
    };
    at(0.05);
    expect(seen).toEqual([]);
    at(0.2);
    expect(seen).toEqual([0]);
    at(0.95);
    expect(seen).toEqual([0, 1]);
    at(1.2);
    expect(seen).toEqual([0, 1]);
    el.dispatchEvent(new Event('ended'));
    await expect(pending).resolves.toMatchObject({ via: 'clip', interrupted: false });
    // The last phrase is never skipped, even when no timeupdate reached it.
    expect(seen).toEqual([0, 1, 2]);
  });

  it('speaks one utterance per phrase on the device voice', async () => {
    await updateSettings({ deviceToken: undefined });
    const seen: number[] = [];
    await play({ text: '{今日|きょう}は／いい{天気|てんき}です' }, { phrases: ['{今日|きょう}は', 'いい{天気|てんき}です'], onPhrase: (i) => seen.push(i) });
    expect(device.spoken.map((s) => s.text)).toEqual(['{今日|きょう}は', 'いい{天気|てんき}です']);
    expect(seen).toEqual([0, 1]);
  });
});

describe('interruptions', () => {
  it('a new play() cancels the one playing; stopAudio() and an abort signal stop it too', async () => {
    const elements = holdPlayback();
    const first = play({ ref: 'core:cw-0001' });
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    const second = play({ ref: 'kana:あ' });
    await expect(first).resolves.toMatchObject({ via: 'clip', interrupted: true });
    await vi.waitFor(() => expect(elements).toHaveLength(2));

    stopAudio();
    await expect(second).resolves.toMatchObject({ via: 'clip', interrupted: true });

    const controller = new AbortController();
    const third = play({ ref: 'kana:あ' }, { signal: controller.signal });
    await vi.waitFor(() => expect(elements).toHaveLength(3));
    controller.abort();
    await expect(third).resolves.toMatchObject({ interrupted: true });
  });

  it('cancels a pending server request when stopped, so play() settles at once', async () => {
    let ttsSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost:3000');
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/health') return json(health);
      if (url.pathname.startsWith('/audio/')) return clipAnswer(url.pathname);
      // The engine is busy: the answer would take up to the 15-s timeout.
      ttsSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        ttsSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const first = play({ text: 'まいにち' });
    await vi.waitFor(() => expect(ttsPosts()).toBe(1));
    stopAudio();
    await expect(first).resolves.toMatchObject({ via: 'none', interrupted: true });
    expect(ttsSignal?.aborted).toBe(true);
    expect(device.spoken).toEqual([]);

    // A newer play() cancels it the same way.
    const second = play({ text: 'まいばん' });
    await vi.waitFor(() => expect(ttsPosts()).toBe(2));
    const third = play({ ref: 'kana:あ' });
    await expect(second).resolves.toMatchObject({ interrupted: true });
    await expect(third).resolves.toMatchObject({ via: 'clip', interrupted: false });

    // Being cancelled is not a server failure: the next line still goes to the server.
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost:3000');
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return url.pathname === '/api/health' ? json(health) : wav();
    });
    await expect(play({ text: 'まいあさ' })).resolves.toMatchObject({ via: 'server' });
  });

  it('never rejects, even when the manifest cannot load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixtures.manifest = Promise.reject(new Error('boom')) as unknown as AudioManifest;
    await expect(play({ text: 'はい' })).resolves.toMatchObject({ via: 'server' });
    expect(warn).toHaveBeenCalledWith('audio manifest unavailable', expect.any(Error));
  });
});

describe('hasClip', () => {
  it('is true only for a pre-generated clip', async () => {
    await expect(hasClip({ ref: 'core:cw-0001' })).resolves.toBe(true);
    await expect(hasClip({ ref: 'pitch:core:cw-0001' })).resolves.toBe(false);
    await expect(hasClip({ text: '{食|た}べる' })).resolves.toBe(true);
    await expect(hasClip({ text: '橋' })).resolves.toBe(false);
    await expect(hasClip({ ref: 'constructor' })).resolves.toBe(false);
  });
});

describe('packs', () => {
  it('keeps the kana pack warm during the sprint, then the current and next unit and chapter, always with misc', () => {
    expect(packsFor({ sprint: true, unit: 1, chapter: 0 })).toEqual(['kana', 'u01', 'misc']);
    expect(packsFor({ sprint: false, unit: 3, chapter: 5 })).toEqual(['u03', 'u04', 'c05', 'c06', 'misc']);
    expect(packsFor({ sprint: false, unit: 12, chapter: 0 })).toEqual(['u12', 'u13', 'c01', 'c02', 'misc']);
  });

  it('prefetches the clips of the packs it is given, skipping cached ones', async () => {
    const cache = installCaches();
    await (await caches.open('issho-audio-v1')).put('/audio/a1/taberu.m4a', new Response('cached'));
    await expect(prefetchPacks(['u01', 'misc'])).resolves.toBe(3);
    expect(requests.sort()).toEqual(['GET /audio/e5/u01b.m4a', 'GET /audio/e6/u01c.m4a', 'GET /audio/f7/misc.m4a']);
    expect(cache('issho-audio-v1').paths().sort()).toEqual([
      '/audio/a1/taberu.m4a', '/audio/e5/u01b.m4a', '/audio/e6/u01c.m4a', '/audio/f7/misc.m4a',
    ]);
    // Everything is cached now.
    await expect(prefetchPacks(['u01', 'misc'])).resolves.toBe(0);
  });

  it('respects max', async () => {
    installCaches();
    await expect(prefetchPacks(['u01'], { max: 2 })).resolves.toBe(2);
  });

  it('skips files the server does not have (a 404, or index.html from a dev server)', async () => {
    const cache = installCaches();
    clipAnswer = (path) => path === '/audio/e5/u01b.m4a'
      ? json({ error: 'not_found' }, 404)
      : path === '/audio/e6/u01c.m4a'
        ? new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
    await expect(prefetchPacks(['u01'])).resolves.toBe(1);
    expect(cache('issho-audio-v1').paths()).toEqual(['/audio/a1/taberu.m4a']);
  });

  it('does nothing offline, with Save-Data or without Cache Storage, and stops when the network goes away', async () => {
    await expect(prefetchPacks(['u01'])).resolves.toBe(0); // no caches
    installCaches();
    online = false;
    await expect(prefetchPacks(['u01'])).resolves.toBe(0);
    online = true;
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    await expect(prefetchPacks(['u01'])).resolves.toBe(0);
    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
    expect(requests).toEqual([]);

    clipAnswer = () => { throw new TypeError('Failed to fetch'); };
    await expect(prefetchPacks(['u01', 'u02', 'kana', 'c01'])).resolves.toBe(0);
    expect(requests.length).toBeLessThanOrEqual(4);
  });
});

describe('installAudioUnlock', () => {
  it('plays a moment of silence on the first gesture only', async () => {
    const elements = holdPlayback();
    const stop = installAudioUnlock();
    document.dispatchEvent(new Event('pointerup'));
    expect(elements).toHaveLength(1);
    expect(elements[0].src).toMatch(/^blob:/);
    document.dispatchEvent(new Event('pointerup'));
    document.dispatchEvent(new Event('keydown'));
    expect(elements).toHaveLength(1);
    stop();
  });
});

describe('usePlayback', () => {
  it('reports playing and how the audio was played, and stops its own playback on unmount', async () => {
    const elements = holdPlayback();
    const { result, unmount } = renderHook(() => usePlayback());
    let pending!: ReturnType<typeof play>;
    act(() => { pending = result.current.play({ ref: 'core:cw-0001' }); });
    expect(result.current.playing).toBe(true);
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    await act(async () => {
      elements[0].dispatchEvent(new Event('ended'));
      await pending;
    });
    expect(result.current).toMatchObject({ playing: false, via: 'clip' });

    act(() => { pending = result.current.play({ ref: 'kana:あ' }); });
    await vi.waitFor(() => expect(elements).toHaveLength(2));
    unmount();
    await expect(pending).resolves.toMatchObject({ interrupted: true });
  });

  it('shows stopped as soon as Stop is pressed, even while the server is still answering', async () => {
    let release!: () => void;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost:3000');
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      // The health check (not cancellable) is slow to answer.
      if (url.pathname === '/api/health') return new Promise<Response>((resolve) => { release = () => resolve(json(health)); });
      return wav();
    });
    const { result } = renderHook(() => usePlayback());
    let pending!: ReturnType<typeof play>;
    act(() => { pending = result.current.play({ text: 'まいにち' }); });
    await vi.waitFor(() => expect(requests).toContain('GET /api/health'));
    expect(result.current.playing).toBe(true);
    act(() => result.current.stop());
    expect(result.current.playing).toBe(false);
    release();
    await act(async () => { await pending; });
    expect(result.current.playing).toBe(false);
    expect(ttsPosts()).toBe(0);
  });
});
