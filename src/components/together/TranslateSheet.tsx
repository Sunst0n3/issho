// "Stuck? Type it in English": asks the helper how a spouse would say it, and
// lets the learner drop the Japanese into their message.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AiTranslateResponse } from '../../../shared/api.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import { aiTranslate } from '../../sync/client.ts';
import { Icon, Ruby } from '../ui.tsx';
import { aiErrorMessage, aiProblemOf, markAiBroken } from './ai.ts';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: AiTranslateResponse }
  | { kind: 'error'; message: string };

export function TranslateSheet({ knownKanji, onUse, onClose }: {
  knownKanji: string[];
  onUse(japanese: string): void;
  onClose(): void;
}) {
  const id = useId();
  const [english, setEnglish] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const sheet = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      // Keep keyboard focus inside the sheet while it is open.
      if (e.key !== 'Tab' || !sheet.current) return;
      const items = sheet.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, [href]');
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = english.trim();
    if (!text || state.kind === 'loading') return;
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'done', result: await aiTranslate({ english: text, knownKanji }) });
    } catch (err) {
      setState({ kind: 'error', message: aiErrorMessage(err) });
      // The chat stops checking messages too, and Settings can say what's wrong.
      const problem = aiProblemOf(err);
      if (problem) markAiBroken(problem);
    }
  };

  return (
    <>
      <div className="tg-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={sheet} className="tg-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="tg-sheet-head">
          <h2 id={`${id}-title`}>How do I say it?</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={22} /></button>
        </div>
        <form className="tg-sheet-form" onSubmit={submit}>
          <label htmlFor={`${id}-en`} className="label">In English</label>
          <textarea ref={input} id={`${id}-en`} className="text-input tg-sheet-input" rows={2} lang="en" value={english}
            maxLength={500} placeholder="Did you eat dinner yet?" onChange={(e) => setEnglish(e.target.value)} />
          <button type="submit" className="btn ink block" disabled={!english.trim() || state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Thinking…' : 'Show me in Japanese'}
          </button>
        </form>
        {state.kind === 'error' && <p className="tg-form-error" role="alert">{state.message}</p>}
        {state.kind === 'done' && (
          <div className="tg-translate-result" aria-live="polite">
            <p className="tg-translate-jp"><Ruby text={state.result.japanese} /></p>
            {state.result.romaji && <p className="muted">{state.result.romaji}</p>}
            {state.result.note && <p className="tg-translate-note">{state.result.note}</p>}
            <button type="button" className="btn primary block" onClick={() => onUse(rubyToPlain(state.result.japanese))}>
              Use this
            </button>
          </div>
        )}
      </div>
    </>
  );
}
