// Model audio: every "listen" in the app goes through play().
//
// Resolution order, first hit wins:
//   1. a pre-generated VOICEVOX clip (public/audio, listed in audio/manifest.json), by clip ref
//      ('core:cw-0001', 'story:st-l0-07#3', …) or by text (clipTextKey: the reading is part of
//      the key, so a homograph never plays a clip of another reading);
//   2. the home server's VOICEVOX (POST /api/tts) when paired, online and the server has an
//      engine; its WAVs are kept in Cache Storage under a hash of the text, capped at 20 MB;
//   3. the device's Japanese voice (speechSynthesis, tts.ts);
//   4. nothing ('none').
//
// Browser quirks handled here:
// - One shared HTMLAudioElement, unlocked on the first gesture (iOS refuses play() outside a
//   gesture until the element has played once). Clips play from Blob URLs, which avoids iOS
//   Range-request trouble with service-worker responses.
// - Loading a new source resets playbackRate to defaultPlaybackRate, so both are set.
// - When the element refuses to start a clip (autoplay before the unlock, or media paused by the
//   browser), the server is not asked for the same text: its WAV would be refused the same way,
//   at the cost of a synthesis. The device voice reads it instead.
// - jsdom and old browsers have no Cache Storage (`caches`), and plain-http pages have no
//   crypto.subtle: caching is skipped, playback still works.

import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { TTS_MAX_CHARS, type VoiceId } from '../../shared/api.ts';
import { clipTextKey } from '../../shared/voicevox.ts';
import { audioUrl, EMPTY_MANIFEST, loadAudioManifest } from '../lib/data.ts';
import { db, getSettings } from '../lib/db.ts';
import { rubyToKana } from '../lib/ruby.ts';
import type { AudioClip, AudioManifest, RubyText } from '../lib/types.ts';
import { ApiError, fetchTts, health, isPairedSettings } from '../sync/client.ts';
import { getServerStatus } from '../sync/socket.ts';
import { speak, stopSpeaking, ttsAvailable } from './tts.ts';

export type AudioSource =
  | { ref: string }                          // clip ref (§2.2): 'core:cw-0001', 'story:st-l0-07#3', 'kana:あ' …
  | { text: RubyText; voice?: VoiceId };     // any Japanese text (ruby markup gives exact readings)

export interface PlayOptions {
  voice?: VoiceId;                            // default 'f' (clip refs carry their own voice)
  /** Default: the automatic rate (setDefaultAudioRate). */
  rate?: number;
  signal?: AbortSignal;
  /** Story sentences: called with each phrase index as playback reaches its offset. */
  onPhrase?: (index: number) => void;
  /** Phrase texts, for the device fallback (one utterance per phrase) and for clips without offsets. */
  phrases?: readonly RubyText[];
  /** For { ref } sources without a clip: the text to synthesize instead. */
  fallbackText?: RubyText;
}

export type PlayVia = 'clip' | 'server' | 'device' | 'none';
export interface PlayResult { via: PlayVia; ms: number; interrupted: boolean }

/** Runtime cache of clip files; the service worker's CacheFirst route uses the same name (vite.config.ts). */
export const AUDIO_CACHE = 'issho-audio-v1';
/** Server-TTS WAVs, under synthetic '/__tts/<voice>/<sha-256 of the text>' keys. */
export const TTS_CACHE = 'issho-tts-v1';
/** localStorage: [key, bytes, lastUsed][] of TTS_CACHE, oldest dropped first. */
export const TTS_INDEX_KEY = 'issho.tts.index';
export const TTS_CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** After a 503 (no engine, or it is down) the server path is skipped this long. */
export const TTS_UNAVAILABLE_MS = 5 * 60_000;
/** After a timeout or network failure: shorter, the server may just have been asleep. */
const TTS_RETRY_MS = 60_000;
/** How long a health answer (ttsEnabled) is trusted. */
const HEALTH_FRESH_MS = 5 * 60_000;
const PREFETCH_CONCURRENCY = 4;
/** Learners hear model audio a little slower for the first 90 course days. */
const SLOW_RATE = 0.85;
const SLOW_RATE_UNTIL_DAY = 90;
const MIN_RATE = 0.5;
const MAX_RATE = 2;

/**
 * How a Blob played: to the end; stopped; 'failed' (this file can't be played, e.g. it doesn't
 * decode: another source may work); or 'blocked' (the audio element refused to start at all:
 * autoplay not unlocked yet, or the browser paused background media. Any other Blob would be
 * refused the same way, so only the device voice is worth trying).
 */
type Outcome = 'ended' | 'interrupted' | 'failed' | 'blocked';
type TtsIndexEntry = [key: string, bytes: number, at: number];

let element: HTMLAudioElement | null = null;
/** Bumped by every play() and stopAudio(): a playback whose token is stale was interrupted. */
let generation = 0;
/** The clip or WAV playing now; stop() settles its promise as interrupted. */
let active: { token: number; stop: () => void } | null = null;
/** Cancels the current play()'s requests (clip download, server speech), so a stopped play() settles at once. */
let fetching: AbortController | null = null;
let rateCourseDay = 1;
let rateOverride: number | undefined;
let serverDownUntil = 0;
let healthCache: { at: number; enabled: boolean } | null = null;

// ---- Rate --------------------------------------------------------------------

function validRate(rate: unknown): number | undefined {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rate : undefined;
}

/** Settings.audioRate when set, else 0.85 until course day 90, then 1. Session and Today call it after planning. */
export function setDefaultAudioRate(courseDay: number, audioRate?: number): void {
  rateCourseDay = courseDay;
  rateOverride = validRate(audioRate);
}

/** The rate play() uses when the caller gives none. */
export function getDefaultAudioRate(): number {
  return rateOverride ?? (rateCourseDay <= SLOW_RATE_UNTIL_DAY ? SLOW_RATE : 1);
}

// ---- Manifest lookup -----------------------------------------------------------

function own(record: Record<string, string> | undefined, key: string): string | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

async function manifest(): Promise<AudioManifest> {
  try {
    return await loadAudioManifest();
  } catch (e) {
    console.warn('audio manifest unavailable', e);
    return EMPTY_MANIFEST;
  }
}

function voiceOf(source: AudioSource, opts: PlayOptions): VoiceId {
  return ('text' in source ? source.voice : undefined) ?? opts.voice ?? 'f';
}

function findClip(m: AudioManifest, source: AudioSource, voice: VoiceId, fallbackText?: RubyText): AudioClip | undefined {
  let id: string | undefined;
  if ('ref' in source) {
    id = own(m.byRef, source.ref);
    if (!id && fallbackText?.trim()) id = own(m.byText, clipTextKey(voice, fallbackText));
  } else if (source.text.trim()) {
    id = own(m.byText, clipTextKey(voice, source.text));
  }
  return id && m.clips && Object.prototype.hasOwnProperty.call(m.clips, id) ? m.clips[id] : undefined;
}

/** A verified pre-generated clip exists (the pitch drill only runs on these). */
export async function hasClip(source: AudioSource): Promise<boolean> {
  return findClip(await manifest(), source, voiceOf(source, {})) !== undefined;
}

// ---- Cache Storage helpers -------------------------------------------------------

async function openCache(name: string): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

function controlledByServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
}

/** A clip file, not an error or the app's index.html (Vite's dev and preview servers answer a missing file with it, as 200). */
function isClipResponse(res: Response): boolean {
  return res.ok && !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}

/** A clip's bytes: from the runtime cache, else the network (which the service worker caches). */
async function clipBlob(clip: AudioClip, signal?: AbortSignal): Promise<Blob | null> {
  const url = audioUrl(clip.file);
  try {
    const cache = await openCache(AUDIO_CACHE);
    const hit = await cache?.match(url);
    if (hit) return await hit.blob();
    const res = await fetch(url, { signal });
    if (!isClipResponse(res)) return null;
    // Without a controlling service worker (first visit, or none) keep the clip for offline use here.
    if (cache && !controlledByServiceWorker()) await cache.put(url, res.clone()).catch(() => {});
    return await res.blob();
  } catch {
    return null;
  }
}

// ---- Server TTS --------------------------------------------------------------------

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** '/__tts/<voice>/<sha-256 hex>': the text itself never becomes a URL. Null without Cache Storage or crypto.subtle. */
async function ttsKey(voice: VoiceId, text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof caches === 'undefined' || !subtle) return null;
  try {
    return `/__tts/${voice}/${hex(await subtle.digest('SHA-256', new TextEncoder().encode(text)))}`;
  } catch {
    return null;
  }
}

function readTtsIndex(): TtsIndexEntry[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(TTS_INDEX_KEY) ?? 'null') as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every((e) => Array.isArray(e) && e.length === 3 && typeof e[0] === 'string'
      && typeof e[1] === 'number' && typeof e[2] === 'number');
    return valid ? (parsed as TtsIndexEntry[]) : null;
  } catch {
    return null;
  }
}

function writeTtsIndex(index: TtsIndexEntry[]): void {
  try {
    localStorage.setItem(TTS_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Storage blocked or full: the next write rebuilds the index from the cache.
  }
}

/** Rebuilds a lost index from the cache's own entries (their age is unknown, so they go first). */
async function rebuildTtsIndex(cache: Cache): Promise<TtsIndexEntry[]> {
  const index: TtsIndexEntry[] = [];
  for (const request of await cache.keys()) {
    const res = await cache.match(request);
    if (!res) continue;
    index.push([new URL(request.url, location.href).pathname, (await res.blob()).size, 0]);
  }
  return index;
}

async function ttsCacheGet(key: string): Promise<Blob | null> {
  try {
    const cache = await openCache(TTS_CACHE);
    const hit = await cache?.match(key);
    if (!hit) return null;
    const index = readTtsIndex();
    const at = index?.findIndex(([k]) => k === key) ?? -1;
    if (index && at >= 0) {
      // Most recently used goes last, so entries touched within the same millisecond keep their order.
      const [entry] = index.splice(at, 1);
      index.push([entry[0], entry[1], Date.now()]);
      writeTtsIndex(index);
    }
    return await hit.blob();
  } catch {
    return null;
  }
}

/** Stores a WAV and drops the least recently used ones while the total is over 20 MB. */
/** Index writes in flight, one after another: two overlapping puts would each write an index without the other's entry. */
let ttsCacheWrites: Promise<void> = Promise.resolve();

function ttsCachePut(key: string, wav: Blob): Promise<void> {
  const run = ttsCacheWrites.then(() => ttsCachePutNow(key, wav));
  ttsCacheWrites = run.catch(() => {});
  return run;
}

async function ttsCachePutNow(key: string, wav: Blob): Promise<void> {
  const cache = await openCache(TTS_CACHE);
  if (!cache) return;
  await cache.put(key, new Response(wav, { headers: { 'Content-Type': wav.type || 'audio/wav' } }));
  const index = (readTtsIndex() ?? (await rebuildTtsIndex(cache))).filter(([k]) => k !== key);
  index.push([key, wav.size, Date.now()]);
  index.sort((a, b) => a[2] - b[2]);
  let total = index.reduce((sum, [, bytes]) => sum + bytes, 0);
  while (total > TTS_CACHE_MAX_BYTES && index.length) {
    const [oldest, bytes] = index.shift()!;
    await cache.delete(oldest);
    total -= bytes;
  }
  writeTtsIndex(index);
}

function markServerDown(ms: number): void {
  serverDownUntil = Date.now() + ms;
}

/** Paired, online, the server reachable and it has a VOICEVOX engine (health.ttsEnabled). */
async function serverTtsUsable(): Promise<boolean> {
  if (!online() || Date.now() < serverDownUntil) return false;
  if (!isPairedSettings(await getSettings())) return false;
  // The socket already knows the server is unreachable: don't wait for a request to time out.
  if (getServerStatus() === 'offline') return false;
  if (!healthCache || Date.now() - healthCache.at > HEALTH_FRESH_MS) {
    try {
      const h = await health();
      healthCache = { at: Date.now(), enabled: h.ttsEnabled === true };
    } catch {
      markServerDown(TTS_RETRY_MS);
      return false;
    }
  }
  return healthCache.enabled;
}

/** The server's reading of `text`: from the local TTS cache (works offline), else fetched; null when unavailable. */
async function serverSpeech(text: RubyText, voice: VoiceId, signal?: AbortSignal): Promise<Blob | null> {
  // The server refuses longer text (400): the device voice reads it.
  if (text.trim().length > TTS_MAX_CHARS) return null;
  const key = await ttsKey(voice, text);
  const cached = key ? await ttsCacheGet(key) : null;
  if (cached) return cached;
  if (!(await serverTtsUsable())) return null;
  try {
    const wav = await fetchTts({ text, voice }, { signal });
    if (key) await ttsCachePut(key, wav).catch((e: unknown) => console.warn('could not cache server speech', e));
    return wav;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 503) markServerDown(TTS_UNAVAILABLE_MS);
      else if (e.status === 0 && (e.code === 'network' || e.code === 'timeout')) markServerDown(TTS_RETRY_MS);
      // 429 (rate limited) and the rest: the device voice takes this one.
    }
    return null;
  }
}

// ---- Playback ----------------------------------------------------------------------

function audioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
  }
  return element;
}

function applyRate(el: HTMLAudioElement, rate: number): void {
  const pitched = el as HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
  pitched.preservesPitch = true;
  pitched.webkitPreservesPitch = true;
  pitched.mozPreservesPitch = true;
  try {
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  } catch {
    // A rate the browser refuses: play at normal speed.
  }
}

/** When each phrase starts (ms of media time): the clip's offsets, else proportional to the phrases' kana length. */
interface PhraseTiming {
  count: number;
  /** Start of phrase i given the media duration (ms, NaN while unknown). */
  startOf(i: number, durationMs: number): number;
  onPhrase: (index: number) => void;
}

function phraseTiming(opts: PlayOptions, offsets: readonly number[] | undefined): PhraseTiming | null {
  const { onPhrase, phrases } = opts;
  if (!onPhrase) return null;
  if (offsets?.length) return { count: offsets.length, startOf: (i) => offsets[i], onPhrase };
  if (!phrases?.length) return null;
  const lengths = phrases.map((p) => Math.max(1, Array.from(rubyToKana(p).trim()).length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const before = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  return {
    count: phrases.length,
    // Phrase 0 starts at once; later ones wait until the duration is known.
    startOf: (i, durationMs) => (i === 0 ? 0 : Number.isFinite(durationMs) ? (durationMs * before[i]) / total : Infinity),
    onPhrase,
  };
}

function playBlob(blob: Blob, rate: number, timing: PhraseTiming | null, durationMs: number | undefined, token: number): Promise<Outcome> {
  const el = audioElement();
  const url = URL.createObjectURL(blob);
  return new Promise<Outcome>((resolve) => {
    let next = 0;
    let settled = false;
    const duration = () => durationMs ?? el.duration * 1000;
    const reach = (ms: number) => {
      if (!timing) return;
      while (next < timing.count && ms >= timing.startOf(next, duration())) {
        try { timing.onPhrase(next); } catch (e) { console.error('phrase callback failed', e); }
        next++;
      }
    };
    const onTime = () => reach(el.currentTime * 1000);
    const onEnded = () => {
      // timeupdate fires only every ~250 ms: a short last phrase may not have been reached yet.
      reach(Infinity);
      finish('ended');
    };
    const onError = () => finish('failed');
    function finish(outcome: Outcome) {
      if (settled) return;
      settled = true;
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      if (active?.token === token) active = null;
      URL.revokeObjectURL(url);
      resolve(outcome);
    }
    active = { token, stop: () => finish('interrupted') };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.src = url;
    applyRate(el, rate);
    reach(0);
    let started: Promise<void> | undefined;
    try {
      started = el.play();
    } catch {
      finish('failed');
      return;
    }
    // Autoplay refused (no gesture yet) or paused by the browser: the element itself won't start.
    // Anything else (the source can't be decoded): this file failed, another source may play.
    started?.catch((e: unknown) => finish(refusedToStart(e) ? 'blocked' : 'failed'));
  });
}

/**
 * play() was rejected because the element may not play now, whatever its source: NotAllowedError
 * (autoplay before the gesture unlock, iOS) or AbortError (the browser paused it, e.g. "background
 * media was paused to save power"; a pause() of our own settles the playback as interrupted first).
 */
function refusedToStart(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** Story text marks phrase breaks with '／', which a device voice would read out. */
const unmarked = (text: RubyText) => text.replace(/／/g, '');

async function speakOnDevice(text: RubyText, rate: number, opts: PlayOptions, isCurrent: () => boolean): Promise<Outcome> {
  const phrases = opts.phrases?.length ? opts.phrases : null;
  if (!phrases) {
    await speak(unmarked(text), { rate });
    return isCurrent() ? 'ended' : 'interrupted';
  }
  for (let i = 0; i < phrases.length; i++) {
    try { opts.onPhrase?.(i); } catch (e) { console.error('phrase callback failed', e); }
    await speak(unmarked(phrases[i]), { rate });
    if (!isCurrent()) return 'interrupted';
  }
  return 'ended';
}

/** Stops whatever play() is playing (clip, server speech or the device voice). */
export function stopAudio(): void {
  generation++;
  fetching?.abort();
  fetching = null;
  const playing = active;
  active = null;
  playing?.stop();
  element?.pause();
  stopSpeaking();
}

/**
 * Plays model audio. Resolution: clip by ref → clip by byText[clipTextKey(voice, text)] (plain kanji text
 * without ruby has key reading '' and so hits only the unambiguous plain index; a text with a reading never
 * gets a clip of another reading) → server TTS (paired, health.ttsEnabled, online) → device speechSynthesis
 * → none. Cancels whatever is playing. Never rejects.
 */
export async function play(source: AudioSource, opts: PlayOptions = {}): Promise<PlayResult> {
  stopAudio();
  const token = generation;
  const startedAt = Date.now();
  const { signal } = opts;
  const isCurrent = () => token === generation && !signal?.aborted;
  const result = (via: PlayVia, interrupted = false): PlayResult => ({ via, ms: Date.now() - startedAt, interrupted });
  if (signal?.aborted) return result('none', true);
  const onAbort = () => { if (token === generation) stopAudio(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  // Aborted by stopAudio(): by the caller's signal, a newer play() or a Stop button.
  const requests = new AbortController();
  fetching = requests;

  try {
    const rate = validRate(opts.rate) ?? getDefaultAudioRate();
    const voice = voiceOf(source, opts);
    const text = 'text' in source ? source.text : opts.fallbackText;

    const clip = findClip(await manifest(), source, voice, opts.fallbackText);
    if (!isCurrent()) return result('none', true);
    // The audio element refused to start: server speech would be refused too (and cost a synthesis).
    let blocked = false;
    if (clip) {
      const blob = await clipBlob(clip, requests.signal);
      if (!isCurrent()) return result('none', true);
      if (blob) {
        const outcome = await playBlob(blob, rate, phraseTiming(opts, clip.phrases), clip.ms || undefined, token);
        if (outcome === 'ended' || outcome === 'interrupted') return result('clip', outcome === 'interrupted');
        blocked = outcome === 'blocked';
      }
    }
    if (!text?.trim()) return result('none');

    const wav = blocked ? null : await serverSpeech(text, voice, requests.signal);
    if (!isCurrent()) return result('none', true);
    if (wav) {
      const outcome = await playBlob(wav, rate, phraseTiming(opts, undefined), undefined, token);
      if (outcome === 'ended' || outcome === 'interrupted') return result('server', outcome === 'interrupted');
    }
    if (!isCurrent()) return result('none', true);

    if (!ttsAvailable()) return result('none');
    const outcome = await speakOnDevice(text, rate, opts, isCurrent);
    return result('device', outcome === 'interrupted');
  } catch (e) {
    console.warn('audio playback failed', e);
    return result('none', !isCurrent());
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (fetching === requests) fetching = null;
  }
}

// ---- Packs ------------------------------------------------------------------------

const pad2 = (n: number) => String(Math.max(1, Math.floor(n))).padStart(2, '0');

/** Packs to keep warm, always including 'misc': sprint → ['kana', 'u01', 'misc']; after it → current and next unit
 *  ('u03','u04'), current and next kanji chapter ('c05','c06') and 'misc'. */
export function packsFor(p: { sprint: boolean; unit: number; chapter: number }): string[] {
  if (p.sprint) return ['kana', 'u01', 'misc'];
  const unit = Math.max(1, Math.floor(p.unit) || 1);
  const chapter = Math.max(1, Math.floor(p.chapter) || 1);
  return [`u${pad2(unit)}`, `u${pad2(unit + 1)}`, `c${pad2(chapter)}`, `c${pad2(chapter + 1)}`, 'misc'];
}

function saveData(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: { saveData?: boolean } });
  return nav?.connection?.saveData === true;
}

/** Fetches the packs' clips into the runtime cache (4 at a time, skipping cached ones; stops when offline or saveData). Returns the number fetched. */
export async function prefetchPacks(packs: readonly string[], opts: { max?: number; signal?: AbortSignal } = {}): Promise<number> {
  if (!packs.length || !online() || saveData() || opts.signal?.aborted) return 0;
  const cache = await openCache(AUDIO_CACHE);
  if (!cache) return 0;
  const m = await manifest();
  const order = new Map(packs.map((p, i) => [p, i]));
  const files = [...new Set(
    Object.values(m.clips ?? {})
      .filter((c) => order.has(c.pack))
      .sort((a, b) => order.get(a.pack)! - order.get(b.pack)! || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map((c) => c.file),
  )];
  const max = opts.max ?? Infinity;
  let index = 0;
  let claimed = 0;
  let fetched = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped && index < files.length) {
      if (opts.signal?.aborted || !online()) { stopped = true; return; }
      const url = audioUrl(files[index++]);
      if (await cache.match(url).catch(() => undefined)) continue;
      if (claimed >= max) { stopped = true; return; }
      claimed++;
      try {
        const res = await fetch(url, { signal: opts.signal });
        if (!isClipResponse(res)) { claimed--; continue; }
        // A controlling service worker has usually stored it already (CacheFirst).
        if (!(await cache.match(url))) await cache.put(url, res);
        fetched++;
      } catch {
        // The network went away (or the caller aborted): try again another time.
        claimed--;
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  return fetched;
}

// ---- Start-up and React ----------------------------------------------------------------

/** 100 ms of 8 kHz 8-bit silence as a WAV. */
function silentWav(ms = 100): Blob {
  const rate = 8000;
  const samples = Math.round((rate * ms) / 1000);
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);       // fmt chunk size
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, rate, true);     // sample rate
  view.setUint32(28, rate, true);     // byte rate
  view.setUint16(32, 1, true);        // block align
  view.setUint16(34, 8, true);        // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * iOS: unlock HTMLAudioElement playback on the first gesture (plays 100 ms of silence). Returns cleanup.
 * Also follows Settings.audioRate, so a change in Settings applies at once.
 */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const settingsSub = liveQuery(() => db.settings.get('me')).subscribe({
    next: (s) => { rateOverride = validRate(s?.audioRate); },
    error: () => {},
  });

  const events = ['pointerup', 'touchend', 'keydown'] as const;
  const remove = () => events.forEach((e) => document.removeEventListener(e, unlock, true));
  function unlock() {
    remove();
    // Something is already playing on the element, so it is unlocked.
    if (active) return;
    const el = audioElement();
    const url = URL.createObjectURL(silentWav());
    el.src = url;
    // Must run inside the gesture: no await before play().
    let started: Promise<void> | undefined;
    try {
      started = el.play();
    } catch {
      // Ignored: the next real play() tries again.
    }
    const release = () => { if (el.src === url) el.removeAttribute('src'); URL.revokeObjectURL(url); };
    if (started) started.then(() => el.addEventListener('ended', release, { once: true }), release);
    else release();
  }
  events.forEach((e) => document.addEventListener(e, unlock, { capture: true, passive: true }));

  return () => {
    remove();
    settingsSub.unsubscribe();
  };
}

/** React: { play, stop, playing, via }. Unmounting stops the component's own playback. */
export function usePlayback(): { play: typeof play; stop: () => void; playing: boolean; via?: PlayVia } {
  const [state, setState] = useState<{ playing: boolean; via?: PlayVia }>({ playing: false });
  const mine = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (mine.current && mine.current === generation) stopAudio();
    };
  }, []);

  const start = useCallback(async (source: AudioSource, opts?: PlayOptions): Promise<PlayResult> => {
    setState((s) => ({ ...s, playing: true }));
    const pending = play(source, opts);
    // play() has taken its token synchronously.
    const token = generation;
    mine.current = token;
    const result = await pending;
    if (mounted.current && mine.current === token) setState({ playing: false, via: result.via });
    return result;
  }, []);

  const stop = useCallback(() => {
    if (!mine.current || mine.current !== generation) return;
    stopAudio();
    // Show it stopped at once: a play() still waiting on the server settles a moment later.
    setState((s) => ({ ...s, playing: false }));
  }, []);

  return { play: start, stop, playing: state.playing, via: state.via };
}

/** Tests: forget the rate, the server-TTS state and the shared element. */
export function resetAudio(): void {
  stopAudio();
  element = null;
  rateCourseDay = 1;
  rateOverride = undefined;
  serverDownUntil = 0;
  healthCache = null;
}
