// One spoken answer at a time through the phone's speech recognition. The mic is offered only where recognition
// exists and the phone is online (checked once, when the prompt appears); typing always stays available beside it.
// A running attempt stops when the prompt goes away, and its late result is then ignored.

import { useEffect, useRef, useState } from 'react';
import { listen, recognitionAvailable, type Listening } from '../../speech/recognition.ts';

export interface SpeechAnswer {
  /** Recognition exists here and the phone was online when the prompt appeared. */
  available: boolean;
  listening: boolean;
  /** Starts listening, or stops the running attempt (which then reports what it heard). */
  toggle: () => void;
  /** Drops the running attempt, if any: what it hears is never reported (the prompt was answered another way). */
  cancel: () => void;
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function useSpeech({ onHeard, onFailed }: {
  /** A non-empty transcript. */
  onHeard: (transcript: string) => void;
  /** Nothing was heard, or recognition failed (denied, offline, network). */
  onFailed?: () => void;
}): SpeechAnswer {
  const [available] = useState(() => recognitionAvailable() && online());
  const [listening, setListening] = useState(false);
  const current = useRef<Listening | null>(null);
  const handlers = useRef({ onHeard, onFailed });
  handlers.current = { onHeard, onFailed };

  useEffect(() => () => {
    const running = current.current;
    current.current = null;
    running?.stop();
  }, []);

  const cancel = () => {
    const running = current.current;
    if (!running) return;
    current.current = null;
    setListening(false);
    running.stop();
  };

  const toggle = () => {
    if (current.current) {
      current.current.stop();
      return;
    }
    const attempt = listen({ lang: 'ja-JP' });
    current.current = attempt;
    setListening(true);
    const settle = (heard: string) => {
      if (current.current !== attempt) return;
      current.current = null;
      setListening(false);
      if (heard) handlers.current.onHeard(heard);
      else handlers.current.onFailed?.();
    };
    attempt.result.then(settle, () => settle(''));
  };

  return { available, listening, toggle, cancel };
}
