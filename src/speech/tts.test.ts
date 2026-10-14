import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tts.ts caches the voice list for the life of the page, so each test loads a fresh copy.
let tts: typeof import('./tts.ts');
let dbModule: typeof import('../lib/db.ts');

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}

const voice = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, voiceURI: `uri:${name}`, localService: true, default: false, ...extra }) as SpeechSynthesisVoice;

class FakeSynth extends EventTarget {
  voices: SpeechSynthesisVoice[] = [];
  spoken: FakeUtterance[] = [];
  current: FakeUtterance | null = null;
  paused = false;
  get speaking() { return this.current !== null; }
  getVoices() { return this.voices; }
  speak(u: FakeUtterance) { this.spoken.push(u); this.current = u; }
  cancel() {
    const u = this.current;
    this.current = null;
    // Like Safari: the cancelled utterance reports an 'interrupted' error, asynchronously.
    if (u) queueMicrotask(() => u.onerror?.({ error: 'interrupted' }));
  }
  resume() { this.paused = false; }
  finish() {
    const u = this.current;
    this.current = null;
    u?.onend?.();
  }
}

let synth: FakeSynth;

beforeEach(async () => {
  vi.resetModules();
  tts = await import('./tts.ts');
  dbModule = await import('../lib/db.ts');
  await dbModule.db.settings.clear();
  synth = new FakeSynth();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('voices', () => {
  it('lists only Japanese voices, best first', () => {
    synth.voices = [
      voice('Samantha', 'en-US'),
      voice('Hattori', 'ja-JP'),
      voice('Kyoko', 'ja-JP'),
      voice('Google 日本語', 'ja-JP', { localService: false }),
      voice('Android ja', 'ja_JP'),
    ];
    expect(tts.japaneseVoices().map((v) => v.name)).toEqual(['Kyoko', 'Google 日本語', 'Hattori', 'Android ja']);
  });

  it('prefers enhanced voices among unknown names', () => {
    synth.voices = [voice('Generic', 'ja-JP'), voice('Generic (Enhanced)', 'ja-JP')];
    expect(tts.japaneseVoices()[0].name).toBe('Generic (Enhanced)');
  });

  it('waits for voices to load', async () => {
    const pending = tts.loadVoices();
    synth.voices = [voice('Kyoko', 'ja-JP')];
    synth.dispatchEvent(new Event('voiceschanged'));
    await expect(pending).resolves.toHaveLength(1);
  });

  it('gives up waiting after a timeout', async () => {
    vi.useFakeTimers();
    const pending = tts.loadVoices(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual([]);
  });
});

describe('speak', () => {
  it('reads ruby text by its kana, in Japanese, slightly slow, and resolves at the end', async () => {
    synth.voices = [voice('Kyoko', 'ja-JP')];
    let done = false;
    const p = tts.speak('{明日|あした}は{雨|あめ}です。').then(() => { done = true; });
    const u = synth.spoken[0];
    expect(u.text).toBe('あしたはあめです。');
    expect(u.lang).toBe('ja-JP');
    expect(u.rate).toBe(0.9);
    expect(u.voice?.name).toBe('Kyoko');
    await Promise.resolve();
    expect(done).toBe(false);
    synth.finish();
    await p;
    expect(done).toBe(true);
  });

  it('speaks synchronously even before voices have loaded (iOS gesture rule)', () => {
    void tts.speak('はい');
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].voice).toBeNull();
    expect(synth.spoken[0].lang).toBe('ja-JP');
  });

  it('uses an explicitly chosen voice and rate', () => {
    synth.voices = [voice('Kyoko', 'ja-JP'), voice('Otoya', 'ja-JP')];
    void tts.speak('はい', { voiceURI: 'uri:Otoya', rate: 1.2 });
    expect(synth.spoken[0].voice?.name).toBe('Otoya');
    expect(synth.spoken[0].rate).toBe(1.2);
  });

  it('cancels what was playing; the earlier call resolves', async () => {
    const first = tts.speak('いち');
    const second = tts.speak('に');
    await expect(first).resolves.toBeUndefined();
    expect(synth.current?.text).toBe('に');
    synth.finish();
    await expect(second).resolves.toBeUndefined();
  });

  it('resolves on errors instead of rejecting', async () => {
    const p = tts.speak('はい');
    synth.spoken[0].onerror?.({ error: 'synthesis-failed' });
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves even if the browser never reports the end', async () => {
    vi.useFakeTimers();
    const p = tts.speak('はい');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBeUndefined();
  });

  it('does nothing for empty text', async () => {
    await tts.speak('  ');
    expect(synth.spoken).toHaveLength(0);
  });

  it('stopSpeaking() ends the current utterance', async () => {
    const p = tts.speak('はい');
    tts.stopSpeaking();
    await expect(p).resolves.toBeUndefined();
    expect(synth.current).toBeNull();
  });

  it('is a no-op where speech synthesis is missing', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    Reflect.deleteProperty(window, 'speechSynthesis');
    expect(tts.ttsAvailable()).toBe(false);
    await expect(tts.speak('はい')).resolves.toBeUndefined();
  });
});

describe('installSpeechUnlock', () => {
  it('speaks one silent utterance on the first tap only', () => {
    const remove = tts.installSpeechUnlock();
    document.dispatchEvent(new Event('pointerup'));
    document.dispatchEvent(new Event('pointerup'));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].volume).toBe(0);
    remove();
  });

  it('makes speak() use the voice chosen in settings', async () => {
    synth.voices = [voice('Kyoko', 'ja-JP'), voice('Otoya', 'ja-JP')];
    await dbModule.updateSettings({ ttsVoice: 'uri:Otoya' });
    const remove = tts.installSpeechUnlock();
    await vi.waitFor(() => expect(tts.japaneseVoices()[0].name).toBe('Otoya'));
    void tts.speak('はい');
    expect(synth.spoken.at(-1)?.voice?.name).toBe('Otoya');
    remove();
  });
});
