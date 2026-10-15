// WAV → AAC-LC .m4a (mono, 32 kbps). ffmpeg is preferred: its output is bit-exact (identical input gives identical
// bytes, so re-runs do not churn git) and about half the container overhead of afconvert for one-word clips.

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type EncoderName = 'ffmpeg' | 'afconvert';

/** Encodes a WAV file to an .m4a file. */
export type Encoder = (wavPath: string, outPath: string) => Promise<void>;

function available(cmd: string, args: string[]): boolean {
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  return !res.error;
}

/** ffmpeg when installed, else afconvert (macOS), else null. `prefer` forces one (null when it is missing). */
export function detectEncoder(prefer?: EncoderName): EncoderName | null {
  const ffmpeg = () => available('ffmpeg', ['-version']);
  // afconvert has no version flag; -h prints usage and exits non-zero, which is fine: only a spawn error matters.
  const afconvert = () => available('afconvert', ['-h']);
  if (prefer === 'ffmpeg') return ffmpeg() ? 'ffmpeg' : null;
  if (prefer === 'afconvert') return afconvert() ? 'afconvert' : null;
  if (ffmpeg()) return 'ffmpeg';
  if (afconvert()) return 'afconvert';
  return null;
}

export function encoderArgs(name: EncoderName, wavPath: string, outPath: string): [string, string[]] {
  if (name === 'ffmpeg') {
    return [
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-c:a', 'aac', '-b:a', '32k',
        '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', outPath],
    ];
  }
  return ['afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', '-c', '1', wavPath, outPath]];
}

export function makeEncoder(name: EncoderName): Encoder {
  return async (wavPath, outPath) => {
    const [cmd, args] = encoderArgs(name, wavPath, outPath);
    await run(cmd, args);
  };
}

/** Duration (ms) of a PCM WAV from its header: data bytes / (rate · channels · bytes per sample). */
export function wavDurationMs(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  if (wav.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let rate = 0;
  let channels = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= wav.byteLength; ) {
    const id = tag(at);
    const len = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === 'data') {
      if (!rate || !channels || !bits) throw new Error('WAV data before its format chunk');
      // A streamed WAV may carry a placeholder length: trust the bytes actually present.
      const bytes = Math.min(len, wav.byteLength - at - 8);
      return Math.round((bytes / (rate * channels * (bits / 8))) * 1000);
    }
    at += 8 + len + (len % 2);
  }
  throw new Error('WAV has no data chunk');
}
