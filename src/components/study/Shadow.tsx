// Shadowing: record yourself saying the sentence, then play your take and the
// model voice back to back. Where speech recognition works, it also says
// whether you sounded close; that check never holds anything up.

import { useEffect, useRef, useState } from 'react';
import { similarity } from '../../speech/compare.ts';
import { listen, recognitionAvailable, type Listening } from '../../speech/recognition.ts';
import { micAvailable, RecorderError, startRecording, type Recording } from '../../speech/recorder.ts';
import { play, stopAudio, type AudioSource } from '../../speech/audio.ts';
import { Icon } from '../ui.tsx';

/** Shadowing a sentence takes a few seconds; stop long before the recorder's own limit. */
const MAX_TAKE_MS = 20_000;
/** Similarity from which a take "sounds close". */
export const CLOSE_ENOUGH = 0.75;

type Phase = 'idle' | 'starting' | 'recording' | 'recorded';

function recorderMessage(e: unknown): string {
  if (e instanceof RecorderError) {
    if (e.code === 'denied') return 'Microphone access is off. You can allow it in your browser settings.';
    if (e.code === 'no-mic') return 'No microphone was found.';
    if (e.code === 'unavailable') return 'Recording is not available here.';
  }
  return "Recording didn't work. Try again.";
}

export function Shadow({ text, source }: {
  /** The sentence (ruby markup allowed): compared with what was heard, and spoken when there is no clip. */
  text: string;
  /** The model voice: a clip ref (the sentence's own clip), else the text. */
  source?: AudioSource;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [audioUrl, setAudioUrl] = useState<string>();
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  const listening = useRef<Listening | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const mounted = useRef(false);

  // A live level meter while recording.
  useEffect(() => {
    if (phase !== 'recording') return;
    let frame = 0;
    const tick = () => {
      setLevel(recording.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.current?.cancel();
      listening.current?.stop();
      player.current?.pause();
    };
  }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  if (!micAvailable()) {
    return <p className="st-shadow-note">Shadowing needs a microphone (and the app opened over https).</p>;
  }

  const finished = (blob: Blob) => {
    recording.current = null;
    setAudioUrl(URL.createObjectURL(blob));
    setPhase('recorded');
  };

  const start = async () => {
    setError(undefined);
    setScore(null);
    stopAudio();
    player.current?.pause();
    setPhase('starting');
    // Recognition must start inside the tap on iOS, so before awaiting the mic.
    if (recognitionAvailable()) {
      const l = listen({ lang: 'ja-JP', timeoutMs: MAX_TAKE_MS });
      listening.current = l;
      l.result.then(
        (heard) => { if (heard && listening.current === l) setScore(similarity(text, heard)); },
        () => {},
      );
    }
    try {
      const take = await startRecording({ maxMs: MAX_TAKE_MS });
      // Left while the permission prompt was up: turn the microphone straight off.
      if (!mounted.current) {
        take.cancel();
        return;
      }
      recording.current = take;
      setPhase('recording');
      // Also covers hitting the time limit.
      take.done.then(finished, () => {});
    } catch (e) {
      listening.current?.stop();
      listening.current = null;
      setError(recorderMessage(e));
      setPhase('idle');
    }
  };

  const stop = () => {
    listening.current?.stop();
    void recording.current?.stop();
  };

  const playMine = () => {
    if (!audioUrl) return;
    stopAudio();
    player.current?.pause();
    player.current = new Audio(audioUrl);
    void player.current.play().catch(() => setError("Your recording couldn't play here."));
  };

  const playModel = () => {
    player.current?.pause();
    void play(source ?? { text }, source && 'ref' in source ? { fallbackText: text } : {});
  };

  return (
    <div className="st-shadow">
      {phase === 'recording' ? (
        <div className="st-row">
          <button type="button" className="btn primary st-grow" onClick={stop}>
            <Icon name="stop" size={18} />Stop
          </button>
          <span className="st-level" aria-hidden="true"><span style={{ transform: `scaleX(${Math.max(0.04, level)})` }} /></span>
          <span className="visually-hidden" role="status">Recording</span>
        </div>
      ) : (
        <button type="button" className="btn secondary block" onClick={() => void start()} disabled={phase === 'starting'}>
          <Icon name="mic" size={18} />
          {phase === 'recorded' ? 'Record again' : 'Shadow: say it yourself'}
        </button>
      )}
      {phase === 'recorded' && (
        <div className="st-row">
          <button type="button" className="btn secondary small st-grow" onClick={playMine}>
            <Icon name="play" size={16} />Yours
          </button>
          <button type="button" className="btn secondary small st-grow" onClick={playModel}>
            <Icon name="speaker" size={16} />Model
          </button>
        </div>
      )}
      {phase === 'recorded' && score !== null && (
        <p className={score >= CLOSE_ENOUGH ? 'st-shadow-score good' : 'st-shadow-score'} role="status">
          {score >= CLOSE_ENOUGH ? 'Sounds close' : 'Try again: listen once more, then copy the rhythm.'}
        </p>
      )}
      {error && <p className="st-shadow-note" role="alert">{error}</p>}
    </div>
  );
}
