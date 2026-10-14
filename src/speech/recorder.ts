// Microphone recording for shadowing and voice messages (MediaRecorder).
// iOS Safari records AAC in audio/mp4; Chrome/Firefox record Opus in audio/webm.
// AAC/mp4 is preferred whenever the browser can produce it because every phone can
// play it back, which matters for voice messages sent to the partner's phone.
// getUserMedia needs a secure context: over plain http on the LAN micAvailable()
// is false.

export type RecorderErrorCode = 'unavailable' | 'denied' | 'no-mic' | 'failed';

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;
  constructor(code: RecorderErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RecorderError';
    this.code = code;
  }
}

export interface Recording {
  /** The container type actually being recorded, e.g. 'audio/mp4' or 'audio/webm;codecs=opus'. */
  readonly mimeType: string;
  /** Stops recording; resolves with the audio. Safe to call more than once. */
  stop(): Promise<Blob>;
  /** Stops and throws the audio away. */
  cancel(): void;
  /** Current input level 0..1, for a live meter. */
  level(): number;
  /** Milliseconds since recording started. */
  elapsed(): number;
  /** Settles when recording ends for any reason, including hitting the time limit. */
  readonly done: Promise<Blob>;
}

export const MAX_RECORDING_MS = 60_000;

// Plain 'audio/mp4' comes after WebM: in Chrome it can mean Opus-in-MP4, which
// older iPhones cannot play. Safari matches the AAC entry (or plain mp4 before 18.4).
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function micAvailable(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined';
}

export function pickMimeType(isSupported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string {
  return MIME_CANDIDATES.find((t) => { try { return isSupported(t); } catch { return false; } }) ?? '';
}

/** 'audio/webm;codecs=opus' → 'audio/webm' (what the server accepts as a content type). */
export function baseMimeType(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
}

type AudioContextCtor = typeof AudioContext;

/** A level meter on the mic stream. Returns null where Web Audio is unavailable. */
function createMeter(stream: MediaStream): { level(): number; close(): void } | null {
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    // iOS creates contexts suspended unless inside a gesture; resuming is harmless otherwise.
    void ctx.resume().catch(() => {});
    const buf = new Uint8Array(analyser.fftSize);
    return {
      level() {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        // Speech RMS sits around 0.02..0.3; scale so normal talking fills most of a meter.
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      },
      close() { void ctx.close().catch(() => {}); },
    };
  } catch {
    return null;
  }
}

/**
 * Asks for the microphone and starts recording. Call from a user gesture.
 * Recording stops by itself after `maxMs` (60 s); `done` resolves then.
 */
export async function startRecording({ maxMs = MAX_RECORDING_MS }: { maxMs?: number } = {}): Promise<Recording> {
  if (!micAvailable()) {
    throw new RecorderError('unavailable', 'Recording is not available here (it needs HTTPS and a microphone).');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new RecorderError('denied', 'Microphone permission was denied.');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new RecorderError('no-mic', 'No microphone was found.');
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }

  const preferred = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }
  const meter = createMeter(stream);
  const chunks: Blob[] = [];
  const startedAt = performance.now();
  let cancelled = false;

  const release = () => {
    clearTimeout(limit);
    stream.getTracks().forEach((t) => t.stop());
    meter?.close();
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    recorder.onstop = () => {
      release();
      if (cancelled) reject(new RecorderError('failed', 'Recording was cancelled.'));
      else resolve(new Blob(chunks, { type: recorder.mimeType || preferred || chunks[0]?.type || 'audio/mp4' }));
    };
    recorder.onerror = () => {
      release();
      reject(new RecorderError('failed', 'The recording failed.'));
    };
  });
  // Callers that only cancel never read `done`; keep that from surfacing as unhandled.
  done.catch(() => {});

  const stopRecorder = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const limit = setTimeout(stopRecorder, maxMs);
  try {
    recorder.start();
  } catch (e) {
    // Otherwise the microphone stays live (and the recording indicator stays on).
    release();
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }

  return {
    mimeType: recorder.mimeType || preferred,
    done,
    stop() {
      stopRecorder();
      return done;
    },
    cancel() {
      cancelled = true;
      if (recorder.state === 'inactive') release();
      else recorder.stop();
    },
    level: () => (meter && recorder.state === 'recording' ? meter.level() : 0),
    elapsed: () => performance.now() - startedAt,
  };
}
