// Japanese text-to-speech on top of the Web Speech API.
//
// Browser quirks handled here:
// - Voices load asynchronously (Chrome, iOS Safari): getVoices() is empty until
//   'voiceschanged' fires, so voice lists are cached and refreshed on that event.
// - iOS Safari only lets speechSynthesis start from a user gesture the first time.
//   speak() therefore calls speechSynthesis.speak() synchronously (never after an
//   await), and installSpeechUnlock() speaks a silent utterance on the first tap so
//   later automatic playback (e.g. audio on card reveal) is allowed.
// - Chrome can garbage-collect an in-flight utterance and never fire 'end'; the
//   current utterance is kept referenced and a watchdog settles the promise.

import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../lib/db.ts';
import { rubyToKana } from '../lib/ruby.ts';

export interface SpeakOptions {
  /** 0.5..2, 1 = normal. Defaults to slightly slow for learners. */
  rate?: number;
  /** SpeechSynthesisVoice.voiceURI; falls back to the settings voice, then the best Japanese voice. */
  voiceURI?: string;
}

const DEFAULT_RATE = 0.9;

/** Voices known to sound natural, best first. Matched against voice names. */
const PREFERRED_NAMES = [/kyoko/i, /o-?ren/i, /google\s*日本語/i, /nanami/i, /haruka/i, /otoya/i, /hattori/i];

let cachedVoices: SpeechSynthesisVoice[] = [];
let settingsVoiceURI: string | undefined;
let current: { utterance: SpeechSynthesisUtterance; settle: () => void } | null = null;

export function ttsAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function isJapanese(v: SpeechSynthesisVoice): boolean {
  // Android reports 'ja_JP', everyone else 'ja-JP'.
  return /^ja([-_]|$)/i.test(v.lang);
}

function rank(v: SpeechSynthesisVoice): number {
  let r = 0;
  if (settingsVoiceURI && v.voiceURI === settingsVoiceURI) r += 1000;
  const named = PREFERRED_NAMES.findIndex((re) => re.test(v.name));
  if (named >= 0) r += 100 - named * 10;
  // iOS/macOS downloadable voices sound far better than the compact defaults.
  if (/enhanced|premium|neural|natural/i.test(`${v.name} ${v.voiceURI}`)) r += 20;
  if (v.localService) r += 5;
  return r;
}

function refreshVoices(): SpeechSynthesisVoice[] {
  if (!ttsAvailable()) return [];
  const all = window.speechSynthesis.getVoices();
  if (all.length) cachedVoices = all;
  return cachedVoices;
}

/** Japanese voices installed on this device, best first. May be empty until voices load. */
export function japaneseVoices(): SpeechSynthesisVoice[] {
  return refreshVoices()
    .filter(isJapanese)
    .sort((a, b) => rank(b) - rank(a));
}

/** Resolves with the Japanese voices once the browser has loaded its voice list (or after a short wait). */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (!ttsAvailable()) return Promise.resolve([]);
  if (refreshVoices().length) return Promise.resolve(japaneseVoices());
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const done = () => {
      synth.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(japaneseVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener('voiceschanged', done);
  });
}

/** Japanese voices for a picker (Settings); updates when the browser loads more voices. */
export function useJapaneseVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => japaneseVoices());
  useEffect(() => {
    if (!ttsAvailable()) return;
    const synth = window.speechSynthesis;
    const update = () => setVoices(japaneseVoices());
    synth.addEventListener('voiceschanged', update);
    update();
    return () => synth.removeEventListener('voiceschanged', update);
  }, []);
  return voices;
}

function pickVoice(voiceURI?: string): SpeechSynthesisVoice | undefined {
  const voices = japaneseVoices();
  return (voiceURI && voices.find((v) => v.voiceURI === voiceURI)) || voices[0];
}

/**
 * Speaks Japanese text (ruby markup is read by its kana, so readings are exact).
 * Cancels anything already speaking. Resolves when speech ends, is interrupted or
 * fails; it never rejects, so callers can fire and forget.
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  if (!ttsAvailable()) return Promise.resolve();
  const spoken = rubyToKana(text).trim();
  stopSpeaking();
  if (!spoken) return Promise.resolve();

  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(spoken);
  utterance.lang = 'ja-JP';
  utterance.rate = opts.rate ?? DEFAULT_RATE;
  // Without a loaded voice, lang alone still selects the system Japanese voice.
  const voice = pickVoice(opts.voiceURI);
  if (voice) utterance.voice = voice;

  return new Promise<void>((resolve) => {
    let settled = false;
    // Generous upper bound: ~0.35 s per character at the chosen rate, plus slack.
    const watchdog = setTimeout(settle, 4000 + (spoken.length * 350) / utterance.rate);
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (current?.utterance === utterance) current = null;
      resolve();
    }
    utterance.onend = settle;
    utterance.onerror = settle;
    current = { utterance, settle };
    // Chrome and iOS can be left paused after the page was backgrounded.
    if (synth.paused) synth.resume();
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (!ttsAvailable()) return;
  const prev = current;
  current = null;
  window.speechSynthesis.cancel();
  // Some browsers never fire 'end'/'error' for a cancelled utterance.
  prev?.settle();
}

/**
 * Call once at startup. Unlocks speech on the first user gesture (iOS), and keeps
 * the preferred voice from settings cached so speak() can stay synchronous.
 * Returns a cleanup function.
 */
export function installSpeechUnlock(): () => void {
  if (!ttsAvailable()) return () => {};
  const synth = window.speechSynthesis;
  const onVoices = () => refreshVoices();
  synth.addEventListener('voiceschanged', onVoices);
  refreshVoices();

  const settingsSub = liveQuery(() => db.settings.get('me')).subscribe({
    next: (s) => { settingsVoiceURI = s?.ttsVoice; },
    error: () => {},
  });

  const unlock = () => {
    remove();
    if (synth.speaking) return;
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    silent.lang = 'ja-JP';
    synth.speak(silent);
  };
  const events = ['pointerup', 'touchend', 'keydown'] as const;
  const remove = () => events.forEach((e) => document.removeEventListener(e, unlock, true));
  events.forEach((e) => document.addEventListener(e, unlock, { capture: true, passive: true }));

  return () => {
    remove();
    synth.removeEventListener('voiceschanged', onVoices);
    settingsSub.unsubscribe();
  };
}
