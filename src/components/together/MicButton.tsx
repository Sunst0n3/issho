// Hold-to-record voice messages: press and hold to record, let go to send,
// slide away (or press Escape) to cancel. Space/Enter work the same way for
// keyboards. A transcript is captured alongside when speech recognition exists.

import { useEffect, useRef, useState } from 'react';
import { listen, recognitionAvailable, type Listening } from '../../speech/recognition.ts';
import { RecorderError, startRecording, type Recording } from '../../speech/recorder.ts';
import { Icon } from '../ui.tsx';

/** Shorter holds are taps, not messages. */
const MIN_RECORDING_MS = 700;
/** Moving the finger this far from where it pressed cancels on release. */
const CANCEL_DISTANCE = 80;

interface Session {
  recording?: Recording;
  listening?: Listening;
  origin?: { x: number; y: number };
  released: boolean;
  cancel: boolean;
}

function recorderMessage(e: unknown): string {
  const code = e instanceof RecorderError ? e.code : 'failed';
  switch (code) {
    case 'denied':
      return 'Allow the microphone for Issho to send voice messages.';
    case 'unavailable':
      return 'Voice messages need a microphone and a secure (https) connection.';
    case 'no-mic':
      return 'No microphone found on this device.';
    default:
      return "The microphone didn't start. Try again.";
  }
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function MicButton({ onVoice, onNotice, disabled }: {
  onVoice(audio: Blob, transcript: string): void;
  onNotice(message: string | undefined): void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'finishing'>('idle');
  const [cancelling, setCancelling] = useState(false);
  const [meter, setMeter] = useState({ elapsed: 0, level: 0 });
  const session = useRef<Session | null>(null);

  useEffect(() => () => {
    session.current?.recording?.cancel();
    session.current?.listening?.stop();
    session.current = null;
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => {
      const rec = session.current?.recording;
      if (rec) setMeter({ elapsed: rec.elapsed(), level: rec.level() });
    }, 100);
    return () => clearInterval(t);
  }, [phase]);

  const finish = async (cancel: boolean) => {
    const s = session.current;
    if (!s) return;
    s.released = true;
    s.cancel = cancel;
    // Still waiting for the microphone: the start handler finishes once it opens.
    if (!s.recording) return;
    session.current = null;
    const rec = s.recording;
    if (cancel || rec.elapsed() < MIN_RECORDING_MS) {
      rec.cancel();
      s.listening?.stop();
      setPhase('idle');
      onNotice(cancel ? undefined : 'Hold the mic while you speak, then let go to send.');
      return;
    }
    setPhase('finishing');
    s.listening?.stop();
    try {
      const [audio, transcript] = await Promise.all([
        rec.stop(),
        s.listening ? s.listening.result.catch(() => '') : Promise.resolve(''),
      ]);
      onVoice(audio, transcript);
    } catch {
      onNotice("The recording didn't work. Try again.");
    } finally {
      setPhase('idle');
    }
  };

  const begin = (origin?: { x: number; y: number }) => {
    if (session.current || disabled) return;
    const s: Session = { origin, released: false, cancel: false };
    session.current = s;
    onNotice(undefined);
    setCancelling(false);
    setMeter({ elapsed: 0, level: 0 });
    setPhase('starting');
    // Recognition needs the network; without it the message just has no transcript.
    if (recognitionAvailable() && navigator.onLine !== false) s.listening = listen({ lang: 'ja-JP', timeoutMs: 60_000 });
    startRecording().then(
      (rec) => {
        if (session.current !== s) {
          rec.cancel();
          return;
        }
        s.recording = rec;
        setPhase('recording');
        // Hitting the 60 s limit sends what was recorded.
        rec.done.then(() => { if (session.current === s) void finish(false); }, () => {});
        if (s.released) void finish(s.cancel);
      },
      (e: unknown) => {
        s.listening?.stop();
        if (session.current === s) session.current = null;
        setPhase('idle');
        onNotice(recorderMessage(e));
      },
    );
  };

  const away = (x: number, y: number) => {
    const o = session.current?.origin;
    return o ? Math.hypot(x - o.x, y - o.y) > CANCEL_DISTANCE : false;
  };

  const active = phase === 'starting' || phase === 'recording';

  return (
    <>
      {active && (
        <div className={cancelling ? 'tg-rec-overlay tg-cancelling' : 'tg-rec-overlay'} role="status">
          <span className="tg-rec-dot" aria-hidden="true" />
          <span className="tg-rec-time">{clock(meter.elapsed)}</span>
          <span className="tg-rec-level" aria-hidden="true"><span style={{ width: `${Math.round(meter.level * 100)}%` }} /></span>
          <span className="tg-rec-hint">{cancelling ? 'Let go to cancel' : 'Slide away to cancel'}</span>
        </div>
      )}
      <button type="button" className={active ? 'tg-mic-btn tg-recording' : 'tg-mic-btn'} disabled={disabled || phase === 'finishing'}
        aria-label="Hold to record a voice message" aria-pressed={active}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          begin({ x: e.clientX, y: e.clientY });
        }}
        onPointerMove={(e) => { if (session.current?.origin) setCancelling(away(e.clientX, e.clientY)); }}
        onPointerUp={(e) => { if (session.current?.origin) void finish(away(e.clientX, e.clientY)); }}
        onPointerCancel={() => void finish(true)}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            begin();
          } else if (e.key === 'Escape') {
            void finish(true);
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            void finish(false);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}>
        <Icon name="mic" size={22} />
      </button>
    </>
  );
}
