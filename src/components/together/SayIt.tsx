// "Say it": listens to the learner say a line and compares it with the script.
// Hidden where the browser has no speech recognition; the screen always offers
// an "I said it" button as well.

import { useEffect, useRef, useState } from 'react';
import { similarity } from '../../speech/compare.ts';
import { listen, recognitionAvailable, RecognitionError, type Listening } from '../../speech/recognition.ts';
import { stopSpeaking } from '../../speech/tts.ts';
import { Icon } from '../ui.tsx';

export type Verdict = 'great' | 'close' | 'retry';

export function verdictFor(score: number): Verdict {
  return score >= 0.75 ? 'great' : score >= 0.5 ? 'close' : 'retry';
}

const VERDICT_TEXT: Record<Verdict, string> = { great: 'Great!', close: 'Close — nearly there', retry: 'Try again' };

function recognitionMessage(e: unknown): string {
  const code = e instanceof RecognitionError ? e.code : 'failed';
  switch (code) {
    case 'offline':
      return "Checking your speaking needs the internet. Tap “I said it” when you're done.";
    case 'not-allowed':
      return 'Allow the microphone to check your speaking, or tap “I said it”.';
    case 'network':
      return "Speech checking couldn't connect. Tap “I said it” when you're done.";
    default:
      return "That didn't work. Try again, or tap “I said it”.";
  }
}

type State =
  | { kind: 'idle' }
  | { kind: 'listening'; interim: string }
  | { kind: 'heard'; verdict: Verdict; heard: string }
  | { kind: 'error'; message: string };

export function SayIt({ expected, onVerdict }: { expected: string; onVerdict?(verdict: Verdict): void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const current = useRef<Listening | null>(null);

  useEffect(() => () => {
    current.current?.stop();
    current.current = null;
  }, []);

  if (!recognitionAvailable()) return null;

  const toggle = () => {
    if (state.kind === 'listening') {
      current.current?.stop();
      return;
    }
    // The phone's own voice would be heard as the answer.
    stopSpeaking();
    const run = listen({ lang: 'ja-JP', timeoutMs: 10_000, interim: (t) => setState({ kind: 'listening', interim: t }) });
    current.current = run;
    setState({ kind: 'listening', interim: '' });
    run.result.then(
      (heard) => {
        if (current.current !== run) return;
        current.current = null;
        if (!heard) {
          setState({ kind: 'error', message: "We didn't catch that. Try again a little closer to the phone." });
          return;
        }
        const verdict = verdictFor(similarity(expected, heard));
        setState({ kind: 'heard', verdict, heard });
        onVerdict?.(verdict);
      },
      (e: unknown) => {
        if (current.current !== run) return;
        current.current = null;
        setState({ kind: 'error', message: recognitionMessage(e) });
      },
    );
  };

  const listening = state.kind === 'listening';
  return (
    <div className="tg-say-it">
      <button type="button" className={listening ? 'btn primary small' : 'btn indigo small'} aria-pressed={listening} onClick={toggle}>
        <Icon name={listening ? 'stop' : 'mic'} size={18} />
        {listening ? 'Listening… tap to stop' : state.kind === 'heard' ? 'Say it again' : 'Say it'}
      </button>
      {listening && state.interim && <p className="tg-say-heard" lang="ja">{state.interim}</p>}
      {state.kind === 'heard' && (
        <div className={state.verdict === 'retry' ? 'feedback bad' : 'feedback good'} role="status">
          <strong>{VERDICT_TEXT[state.verdict]}</strong>
          <span>We heard: <span lang="ja">{state.heard}</span></span>
        </div>
      )}
      {state.kind === 'error' && <p className="tg-say-note" role="status">{state.message}</p>}
    </div>
  );
}
