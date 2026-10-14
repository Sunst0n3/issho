import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen, recognitionAvailable, RecognitionError } from './recognition.ts';

type Alt = { transcript: string; confidence: number };

class FakeRecognizer {
  static last: FakeRecognizer | null = null;
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 5;
  started = false;
  stopped = false;
  aborted = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognizer.last = this; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }

  // ---- driven by the test ----
  results(...parts: Array<[string, boolean]>) {
    const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript, confidence: 0.9 } as Alt], { isFinal }));
    this.onresult?.({ resultIndex: 0, results });
  }
  error(error: string) { this.onerror?.({ error }); }
  end() { this.onend?.(); }
}

let online = true;

beforeEach(() => {
  FakeRecognizer.last = null;
  online = true;
  Object.defineProperty(navigator, 'onLine', { get: () => online, configurable: true });
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognizer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('listen', () => {
  it('configures a single Japanese utterance and resolves with the final transcript', async () => {
    const interim = vi.fn();
    const { result } = listen({ interim });
    const rec = FakeRecognizer.last!;
    expect(rec).toMatchObject({ lang: 'ja-JP', continuous: false, interimResults: true, maxAlternatives: 1, started: true });

    rec.results(['おは', false]);
    rec.results(['おはよう', true], ['ござい', false]);
    rec.results(['おはよう', true], ['ございます', true]);
    rec.end();

    await expect(result).resolves.toBe('おはようございます');
    expect(interim.mock.calls.map(([t]) => t)).toEqual(['おは', 'おはようござい', 'おはようございます']);
  });

  it('falls back to the last interim text when nothing was marked final (iOS)', async () => {
    const { result } = listen({ interim: () => {} });
    FakeRecognizer.last!.results(['すみません', false]);
    FakeRecognizer.last!.end();
    await expect(result).resolves.toBe('すみません');
  });

  it('resolves empty when no speech was heard', async () => {
    const { result } = listen();
    FakeRecognizer.last!.error('no-speech');
    await expect(result).resolves.toBe('');
  });

  it('rejects with not-allowed when permission is denied', async () => {
    const { result } = listen();
    FakeRecognizer.last!.error('not-allowed');
    await expect(result).rejects.toMatchObject({ name: 'RecognitionError', code: 'not-allowed' });
  });

  it('fails fast while offline, since recognition runs in the cloud', async () => {
    online = false;
    const { result } = listen();
    await expect(result).rejects.toMatchObject({ code: 'offline' });
    expect(FakeRecognizer.last).toBeNull();
  });

  it('stop() asks for the result, and gives up waiting if the recognizer hangs', async () => {
    vi.useFakeTimers();
    const { result, stop } = listen();
    const rec = FakeRecognizer.last!;
    rec.results(['はい', false]);
    stop();
    expect(rec.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rec.aborted).toBe(true);
    await expect(result).resolves.toBe('はい');
  });

  it('stops by itself after the timeout', async () => {
    vi.useFakeTimers();
    listen({ timeoutMs: 5_000 });
    const rec = FakeRecognizer.last!;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rec.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.stopped).toBe(true);
  });

  it('does not raise an unhandled rejection when the caller reads the result later', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      online = false;
      const offline = listen();
      online = true;
      const denied = listen();
      FakeRecognizer.last!.error('not-allowed');
      // e.g. a hold-to-talk button that only awaits the result when released
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(offline.result).rejects.toMatchObject({ code: 'offline' });
      await expect(denied.result).rejects.toMatchObject({ code: 'not-allowed' });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports when the browser has no speech recognition', async () => {
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    Reflect.deleteProperty(window, 'webkitSpeechRecognition');
    expect(recognitionAvailable()).toBe(false);
    const err = await listen().result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognitionError);
    expect(err).toMatchObject({ code: 'unavailable' });
  });
});
