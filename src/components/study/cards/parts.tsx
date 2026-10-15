// Building blocks shared by the review cards: the question frame, typed answers with "Show options" as a capped
// hint, multiple choice and the two-button self-grade.

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useSettings, useSettingsLoaded } from '../../../lib/hooks.ts';
import { play, stopAudio, type AudioSource, type PlayOptions } from '../../../speech/audio.ts';
import { KanaInput } from './KanaInput.tsx';
import { BLANK } from './prepare.ts';
import { ShowOptions } from './ShowOptions.tsx';

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

/**
 * A prompt with □ where the character to write goes ('□さ', '□本'): screen readers hear "blank" instead of "white square".
 */
export function Blanked({ text }: { text: string }) {
  const parts = text.split(BLANK);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <><span aria-hidden="true">{BLANK}</span><span className="visually-hidden">blank</span></>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * On mount, when the control that had keyboard focus was just removed (a reveal button, a typed field that gave way),
 * focus moves to `target` instead of falling back to the page: within a card, as focus.ts does between cards.
 */
export function useFocusWhenLost(target: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    if (!active || (document.activeElement && document.activeElement !== document.body)) return;
    target.current?.focus();
    // Only when it appears.
  }, []);
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
export function ChoiceGrid({ options, answer, picked, onPick, lang, render, focusOnShow = false }: {
  options: readonly string[];
  answer: string;
  picked: string | null;
  onPick: (option: string) => void;
  lang?: 'ja';
  /** How an option reads on its button (e.g. with furigana); the option string itself is what is picked. */
  render?: (option: string) => ReactNode;
  /** Opened in place of the control that had focus ("Show options"): focus moves to the choices. */
  focusOnShow?: boolean;
}) {
  const locked = picked !== null;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const group = useRef<HTMLDivElement>(null);
  useFocusWhenLost(group, focusOnShow);

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
    <div ref={group} tabIndex={-1} className={wide ? 'choice-grid st-choices wide' : 'choice-grid st-choices'} role="group" aria-label="Answer choices">
      {options.map((option, i) => {
        const right = locked && option === answer;
        const wrong = locked && option === picked && option !== answer;
        const state = right ? ' correct' : wrong ? ' wrong' : locked ? ' st-dim' : '';
        return (
          <button key={option} type="button" className={`choice${state}`} lang={lang}
            aria-disabled={locked || undefined} onClick={() => !locked && onPick(option)}>
            <span className="st-key" aria-hidden="true">{i + 1}</span>
            {render ? render(option) : option}
            {right && <span className="visually-hidden">, correct answer</span>}
            {wrong && <span className="visually-hidden">, your answer</span>}
          </button>
        );
      })}
    </div>
  );
}

export type TypedKind = 'kana' | 'romaji';

export interface TypedResult {
  correct: boolean;
  /** Wrong tries before the final answer. */
  retries: number;
}

/**
 * A typed answer. Kana answers go through the IME field (romaji → kana as you type); romaji answers (sprint kana
 * cards) are plain letters. A first miss gets one more try when `retry` is on (then graded Hard if it succeeds).
 */
export function TypedAnswer({ kind, label, check, onResult, onMiss, retry = true, katakana = false }: {
  kind: TypedKind;
  label: string;
  check: (input: string) => boolean;
  onResult: (result: TypedResult) => void;
  /** A first wrong try (one more is allowed). */
  onMiss?: () => void;
  retry?: boolean;
  katakana?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [retries, setRetries] = useState(0);
  const [result, setResult] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);

  const finish = (correct: boolean, tries: number) => {
    setResult(correct);
    onResult({ correct, retries: tries });
  };

  const submit = () => {
    if (result !== null || !value.trim()) return;
    if (check(value)) finish(true, retries);
    else if (retry && retries === 0) {
      setRetries(1);
      onMiss?.();
      inputRef.current?.select();
    } else finish(false, retries);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const state = result === null ? '' : result ? ' good' : ' bad';
  return (
    <form className="st-typed" onSubmit={onSubmit} noValidate>
      <label className="label" htmlFor={id}>{label}</label>
      {kind === 'kana' ? (
        <KanaInput id={id} inputRef={inputRef} className={`st-typed-input${state}`} value={value} onChange={setValue}
          onSubmit={submit} readOnly={result !== null} katakana={katakana} describedBy={`${id}-hint`} />
      ) : (
        <input ref={inputRef} id={id} className={`text-input st-typed-input${state}`} value={value}
          onChange={(e) => setValue(e.target.value)} readOnly={result !== null} placeholder="Type the sound in letters"
          lang="en" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="done"
          aria-describedby={`${id}-hint`} />
      )}
      <p id={`${id}-hint`} className="st-typed-hint" aria-live="polite">
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
 * A typed answer with "Show options" as a capped hint: a correct pick is Hard, a wrong one Again (both mode
 * 'choice'). Hands-busy mode shows the choices at once. After a missed typed try the options stay hidden (they would
 * give a free second guess).
 */
export function AnswerArea({ options, answer, lang, typed, handsBusy = false, render, onResult }: {
  options: readonly string[];
  answer: string;
  lang?: 'ja';
  typed: { kind: TypedKind; label: string; check: (input: string) => boolean; katakana?: boolean };
  handsBusy?: boolean;
  /** How a choice reads on its button. */
  render?: (option: string) => ReactNode;
  onResult: (result: AnswerResult) => void;
}) {
  const [choosing, setChoosing] = useState(handsBusy && options.length > 1);
  const [missed, setMissed] = useState(false);
  const [answered, setAnswered] = useState(false);
  const pick = (correct: boolean) => {
    setAnswered(true);
    onResult({ correct, retries: 0, mode: 'choice' });
  };
  return (
    <div className="st-answer">
      {choosing ? (
        <ShowOptions options={options} answer={answer} lang={lang} open focusOnShow={!handsBusy} render={render} onPick={pick} />
      ) : (
        <>
          <TypedAnswer kind={typed.kind} label={typed.label} check={typed.check} katakana={typed.katakana}
            onMiss={() => setMissed(true)} onResult={(r) => { setAnswered(true); onResult({ ...r, mode: 'typed' }); }} />
          {!missed && !answered && <ShowOptions options={options} answer={answer} lang={lang} render={render} onOpen={() => setChoosing(true)} onPick={pick} />}
        </>
      )}
    </div>
  );
}

/** Reveal + self-grade: "Missed" and "Got it" (there is no Easy). The first tap counts; the buttons then disable. */
export function SelfGrade({ onGrade, prompt = 'Did you get it?', missedLabel = 'Missed', gotItLabel = 'Got it', describedBy }: {
  onGrade: (gotIt: boolean) => void;
  prompt?: string;
  missedLabel?: string;
  gotItLabel?: string;
  /** Id of the revealed answer: read out with the question when focus lands on the buttons' group. */
  describedBy?: string;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  // It replaces the reveal button (or the typed field) that had focus: keyboard and screen-reader users land here.
  const group = useRef<HTMLDivElement>(null);
  useFocusWhenLost(group);
  // A ref too: two taps in one frame both see the state from before the first.
  const taken = useRef(false);
  const choose = (gotIt: boolean) => {
    if (taken.current) return;
    taken.current = true;
    setChosen(gotIt);
    onGrade(gotIt);
  };
  return (
    <div ref={group} tabIndex={-1} className="st-selfgrade" role="group" aria-label={prompt} aria-describedby={describedBy}>
      <p className="label">{prompt}</p>
      <div className="st-selfgrade-row two">
        <button type="button" className="st-grade again" disabled={chosen !== null} onClick={() => choose(false)}>{missedLabel}</button>
        <button type="button" className="st-grade good" disabled={chosen !== null} onClick={() => choose(true)}>{gotItLabel}</button>
      </div>
    </div>
  );
}

/** Plays a clip (or speaks the text) when the card appears, once, if audio is on. */
export function useAutoPlay(source: AudioSource | null, opts?: PlayOptions): void {
  const { audio } = useSettings();
  const loaded = useSettingsLoaded();
  const played = useRef(false);
  const key = source ? ('ref' in source ? source.ref : source.text) : '';
  useEffect(() => {
    if (!loaded || !audio || !source || played.current) return;
    played.current = true;
    void play(source, opts);
    // Played once per card: `key` identifies the source.
  }, [loaded, audio, key]);
  useEffect(() => () => stopAudio(), []);
}
