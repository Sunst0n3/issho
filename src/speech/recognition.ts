// Speech-to-text with the Web Speech API ((webkit)SpeechRecognition).
// Available in Chrome and in Safari/iOS 14.5+, but both send audio to a cloud
// service, so it needs a network connection; offline we fail fast with code
// 'offline' instead of waiting for a recognizer that will never answer.

// The DOM lib does not ship SpeechRecognition types; this is the subset we use.
interface RecognitionAlternative { transcript: string; confidence: number }
interface RecognitionResult { readonly isFinal: boolean; readonly length: number; [index: number]: RecognitionAlternative }
interface RecognitionResultList { readonly length: number; [index: number]: RecognitionResult }
interface RecognitionEvent extends Event { readonly resultIndex: number; readonly results: RecognitionResultList }
interface RecognitionErrorEvent extends Event { readonly error: string; readonly message?: string }
interface Recognizer extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecognitionEvent) => void) | null;
  onerror: ((ev: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerConstructor = new () => Recognizer;

export type RecognitionErrorCode = 'unavailable' | 'offline' | 'not-allowed' | 'network' | 'failed';

export class RecognitionError extends Error {
  readonly code: RecognitionErrorCode;
  constructor(code: RecognitionErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RecognitionError';
    this.code = code;
  }
}

export interface ListenOptions {
  lang?: string;
  /** Called with the running transcript while the user speaks. */
  interim?: (text: string) => void;
  /** Stop listening after this long (ms). Default 10 s. */
  timeoutMs?: number;
}

export interface Listening {
  /** The final transcript ('' when nothing was heard). */
  result: Promise<string>;
  /** Stop listening and resolve with what was heard so far. */
  stop(): void;
}

function recognizerClass(): RecognizerConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognizerConstructor; webkitSpeechRecognition?: RecognizerConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function recognitionAvailable(): boolean {
  return recognizerClass() !== undefined;
}

/** How long to wait for the recognizer's 'end' after asking it to stop. */
const STOP_GRACE_MS = 2500;

/** Listens for one utterance. Must be started from a user gesture on iOS. */
export function listen({ lang = 'ja-JP', interim, timeoutMs = 10_000 }: ListenOptions = {}): Listening {
  const Ctor = recognizerClass();
  if (!Ctor) return failed(new RecognitionError('unavailable', 'Speech recognition is not supported on this browser.'));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return failed(new RecognitionError('offline', 'Speech recognition needs an internet connection.'));
  }

  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = Boolean(interim);
  rec.maxAlternatives = 1;

  let finalText = '';
  let latest = '';
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (text: string) => void;
  let rejectResult!: (err: RecognitionError) => void;
  const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });
  // Callers may only read `result` later (e.g. when a hold-to-talk button is released);
  // an early error must not surface as an unhandled rejection in the meantime.
  result.catch(() => {});

  const finish = (err?: RecognitionError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    rec.onresult = rec.onerror = rec.onend = null;
    if (err) rejectResult(err);
    // iOS sometimes ends without marking anything final; fall back to the last interim text.
    else resolveResult((finalText || latest).trim());
  };

  const stop = () => {
    if (settled) return;
    try { rec.stop(); } catch { /* not started yet or already stopped */ }
    graceTimer ??= setTimeout(() => { try { rec.abort(); } catch { /* ignore */ } finish(); }, STOP_GRACE_MS);
  };

  rec.onresult = (ev) => {
    let pending = '';
    finalText = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else pending += r[0].transcript;
    }
    latest = finalText + pending;
    interim?.(latest);
  };
  rec.onerror = (ev) => {
    switch (ev.error) {
      case 'no-speech':
      case 'aborted':
        finish();
        break;
      case 'not-allowed':
      case 'service-not-allowed':
        finish(new RecognitionError('not-allowed', 'Microphone or speech recognition permission was denied.'));
        break;
      case 'network':
        finish(new RecognitionError('network', 'Speech recognition could not reach its service.'));
        break;
      default:
        finish(new RecognitionError('failed', ev.message || ev.error));
    }
  };
  rec.onend = () => finish();

  const timeoutTimer = setTimeout(stop, timeoutMs);
  try {
    rec.start();
  } catch (e) {
    finish(new RecognitionError('failed', e instanceof Error ? e.message : String(e)));
  }
  return { result, stop };
}

function failed(err: RecognitionError): Listening {
  const result = Promise.reject(err);
  result.catch(() => {});
  return { result, stop: () => {} };
}
