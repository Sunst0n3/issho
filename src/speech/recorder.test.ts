import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseMimeType, micAvailable, pickMimeType, RecorderError, startRecording } from './recorder.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickMimeType', () => {
  it('prefers AAC in MP4 (iOS Safari, and Chrome where available)', () => {
    expect(pickMimeType(() => true)).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('uses Opus in WebM on Chrome/Firefox without AAC', () => {
    expect(pickMimeType((t) => t.startsWith('audio/webm') || t === 'audio/mp4')).toBe('audio/webm;codecs=opus');
  });

  it('falls back to plain MP4 on older Safari', () => {
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
  });

  it('lets the browser choose when nothing matches, and survives a throwing check', () => {
    expect(pickMimeType(() => false)).toBe('');
    expect(pickMimeType(() => { throw new Error('nope'); })).toBe('');
  });
});

describe('baseMimeType', () => {
  it('drops codec parameters', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('Audio/MP4')).toBe('audio/mp4');
  });
});

/** A MediaRecorder double: data and 'stop' arrive asynchronously, as in browsers. */
class FakeRecorder {
  static supported = (t: string) => t === 'audio/mp4';
  static isTypeSupported(t: string) { return FakeRecorder.supported(t); }
  static last: FakeRecorder | null = null;
  state: RecordingState = 'inactive';
  readonly mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') throw new DOMException('not recording', 'InvalidStateError');
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['clip'], { type: this.mimeType }) });
      this.onstop?.();
    }, 0);
  }
}

function fakeMic() {
  const track = { stop: vi.fn() };
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  return track;
}

describe('startRecording', () => {
  it('records in the picked format and releases the microphone on stop', async () => {
    const track = fakeMic();
    const rec = await startRecording();
    expect(rec.mimeType).toBe('audio/mp4');
    expect(FakeRecorder.last!.state).toBe('recording');

    const blob = await rec.stop();
    expect(blob.type).toBe('audio/mp4');
    expect(blob.size).toBe(4);
    expect(track.stop).toHaveBeenCalled();
    // A second stop (e.g. button double-tap) returns the same recording instead of throwing.
    await expect(rec.stop()).resolves.toBe(blob);
  });

  it('cancel() throws the audio away and releases the microphone', async () => {
    const track = fakeMic();
    const rec = await startRecording();
    rec.cancel();
    await expect(rec.done).rejects.toBeInstanceOf(RecorderError);
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops by itself at the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const track = fakeMic();
      const rec = await startRecording({ maxMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(FakeRecorder.last!.state).toBe('recording');
      // +1 ms reaches the limit; the recorder then delivers its data on a later tick.
      await vi.advanceTimersByTimeAsync(2);
      await expect(rec.done).resolves.toBeInstanceOf(Blob);
      expect(track.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the microphone when the recorder fails to start', async () => {
    const track = fakeMic();
    const start = vi.spyOn(FakeRecorder.prototype, 'start').mockImplementation(() => {
      throw new DOMException('unsupported', 'NotSupportedError');
    });
    try {
      await expect(startRecording()).rejects.toMatchObject({ name: 'RecorderError', code: 'failed' });
      expect(track.stop).toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  it('is unavailable without getUserMedia (e.g. plain http on the LAN)', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(micAvailable()).toBe(false);
    await expect(startRecording()).rejects.toBeInstanceOf(RecorderError);
  });

  it('maps a denied permission to code "denied"', async () => {
    class Recorder { static isTypeSupported() { return true; } }
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: () => Promise.reject(new DOMException('no', 'NotAllowedError')) },
    });
    await expect(startRecording()).rejects.toMatchObject({ code: 'denied' });
  });
});
