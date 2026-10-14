// Building blocks shared by the review cards: the question frame, multiple
// choice, typed answers and self-grading.

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import { useSettings } from '../../../lib/hooks.ts';
import type { CardRecord } from '../../../lib/types.ts';
import { toKana } from '../../../srs/answers.ts';
import { previewDue } from '../../../srs/scheduler.ts';
import { Icon } from '../../ui.tsx';
import { shortInterval } from '../format.ts';
import { useTypedPreference } from '../prefs.ts';

/** Sizes a one-line Japanese prompt (class st-fit) so long words still fit the card. */
export function fitStyle(text: string): CSSProperties {
  return { '--chars': Math.max(1, [...text].length) } as CSSProperties;
}

/** The question line and the white prompt card under it. */
export function Question({ ask, before, children }: { ask: ReactNode; before?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-question">
      {before}
      <h2 className="st-ask">{ask}</h2>
      <div className="card st-prompt">{children}</div>
    </section>
  );
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** A dialog (e.g. "Stop for now?") is over the card, so keys must not answer it. */
const dialogOpen = () => document.querySelector('[aria-modal="true"]') !== null;

/**
 * A 2×2 grid of options (one column when they are long). Number keys 1–4 pick
 * on a keyboard. Once picked, the right answer fills indigo and a wrong pick is
 * struck through in shu.
 */
export function ChoiceGrid({ options, answer, picked, onPick, lang }: {
  options: readonly string[];
  answer: string;
  picked: string | null;
  onPick: (option: string) => void;
  lang?: 'ja';
}) {
  const locked = picked !== null;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || isTyping(e.target) || dialogOpen()) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault();
        pickRef.current(options[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, options]);

  const wide = options.some((o) => o.length > (lang === 'ja' ? 7 : 16));
  return (
    <div className={wide ? 'choice-grid st-choices wide' : 'choice-grid st-choices'} role="group" aria-label="Answer choices">
      {options.map((option, i) => {
        const right = locked && option === answer;
        const wrong = locked && option === picked && option !== answer;
        const state = right ? ' correct' : wrong ? ' wrong' : locked ? ' st-dim' : '';
        return (
          <button key={option} type="button" className={`choice${state}`} lang={lang}
            aria-disabled={locked || undefined} onClick={() => !locked && onPick(option)}>
            <span className="st-key" aria-hidden="true">{i + 1}</span>
            {option}
            {right && <span className="visually-hidden">, correct answer</span>}
            {wrong && <span className="visually-hidden">, your answer</span>}
          </button>
        );
      })}
    </div>
  );
}

export type TypedKind = 'kana' | 'romaji' | 'meaning';

export interface TypedResult {
  correct: boolean;
  /** Wrong tries before the final answer. */
  retries: number;
}

const PLACEHOLDERS: Record<TypedKind, string> = {
  kana: 'Type in romaji or kana',
  romaji: 'Type the romaji',
  meaning: 'Type the meaning in English',
};

/**
 * A typed answer. Romaji turns into kana as you type for kana answers. A first
 * miss gets one more try (graded Hard if it then succeeds).
 */
export function TypedAnswer({ kind, label, check, onResult, onMiss }: {
  kind: TypedKind;
  label: string;
  check: (input: string) => boolean;
  onResult: (result: TypedResult) => void;
  /** A first wrong try (one more is allowed). */
  onMiss?: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [retries, setRetries] = useState(0);
  const [result, setResult] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const finish = (correct: boolean, tries: number) => {
    setResult(correct);
    onResult({ correct, retries: tries });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (result !== null || !value.trim()) return;
    if (check(value)) finish(true, retries);
    else if (retries === 0) {
      setRetries(1);
      onMiss?.();
      inputRef.current?.select();
    } else finish(false, retries);
  };

  const preview = kind === 'kana' ? toKana(value, { partial: true }) : '';
  const state = result === null ? '' : result ? ' good' : ' bad';
  return (
    <form className="st-typed" onSubmit={submit} noValidate>
      <label className="label" htmlFor={id}>{label}</label>
      <input ref={inputRef} id={id} className={`text-input st-typed-input${state}`} value={value}
        onChange={(e) => setValue(e.target.value)} readOnly={result !== null} placeholder={PLACEHOLDERS[kind]}
        lang={kind === 'meaning' ? 'en' : undefined} autoComplete="off" autoCorrect="off" autoCapitalize="none"
        spellCheck={false} enterKeyHint="done" aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="st-typed-hint" aria-live="polite">
        {kind === 'kana' && preview && <span className="st-preview" lang="ja">{preview}</span>}
        {retries > 0 && result === null && <span className="st-retry">Not quite. One more try.</span>}
      </p>
      {result === null && (
        <div className="st-typed-actions">
          <button type="button" className="btn ghost small" onClick={() => finish(false, retries)}>I don't know</button>
          <button type="submit" className="btn ink small" disabled={!value.trim()}>Check</button>
        </div>
      )}
    </form>
  );
}

export interface AnswerResult extends TypedResult {
  mode: 'choice' | 'typed';
}

/**
 * Multiple choice, with an optional "Type it" toggle (remembered per card kind
 * on this device).
 */
export function AnswerArea({ options, answer, lang, typed, onResult }: {
  options: readonly string[];
  answer: string;
  lang?: 'ja';
  typed?: { view: string; kind: TypedKind; label: string; check: (input: string) => boolean };
  onResult: (result: AnswerResult) => void;
}) {
  const [preferTyped, setPreferTyped] = useTypedPreference(typed?.view ?? 'none');
  const [picked, setPicked] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  // After a missed typed try, switching to choices would give a free second guess.
  const [missed, setMissed] = useState(false);
  const typing = Boolean(typed && preferTyped);

  const pick = (option: string) => {
    if (answered) return;
    setPicked(option);
    setAnswered(true);
    onResult({ correct: option === answer, retries: 0, mode: 'choice' });
  };

  return (
    <div className="st-answer">
      {typing && typed ? (
        <TypedAnswer kind={typed.kind} label={typed.label} check={typed.check} onMiss={() => setMissed(true)}
          onResult={(r) => { setAnswered(true); onResult({ ...r, mode: 'typed' }); }} />
      ) : (
        <ChoiceGrid options={options} answer={answer} picked={picked} onPick={pick} lang={lang} />
      )}
      {typed && !answered && !missed && (
        <button type="button" className="btn ghost small st-mode-toggle" onClick={() => setPreferTyped(!typing)}>
          <Icon name={typing ? 'book' : 'pen'} size={16} />
          {typing ? 'Show choices' : 'Type it instead'}
        </button>
      )}
    </div>
  );
}

const GRADES: { grade: Grade; label: string; tone: string }[] = [
  { grade: Rating.Again, label: 'Again', tone: 'again' },
  { grade: Rating.Hard, label: 'Hard', tone: 'hard' },
  { grade: Rating.Good, label: 'Good', tone: 'good' },
  { grade: Rating.Easy, label: 'Easy', tone: 'easy' },
];

/** Again / Hard / Good / Easy, each with when the card would come back. */
export function SelfGrade({ card, onGrade, intervals = true, prompt = 'How did you do?' }: {
  card: CardRecord;
  onGrade: (grade: Grade) => void;
  /** Hide the intervals (practice repeats are not graded). */
  intervals?: boolean;
  prompt?: string;
}) {
  const { desiredRetention } = useSettings();
  const due = useMemo(() => previewDue(card, new Date(), desiredRetention), [card, desiredRetention]);
  const now = new Date();
  return (
    <div className="st-selfgrade" role="group" aria-label={prompt}>
      <p className="label">{prompt}</p>
      <div className="st-selfgrade-row">
        {GRADES.map(({ grade, label, tone }) => (
          <button key={grade} type="button" className={`st-grade ${tone}`} onClick={() => onGrade(grade)}>
            <span>{label}</span>
            {intervals && <span className="st-grade-when">{shortInterval(due[grade], now)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
