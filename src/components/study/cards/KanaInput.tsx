// The answer field for Japanese: romaji typed on any keyboard turns into kana as you type ('kitte' → きって), and kana
// from a Japanese keyboard (flick or kana input) passes through. While an IME is composing, the field is left alone
// and converted once when composition ends. iOS would otherwise "correct" romaji (kitte → kitten): autocorrect,
// autocapitalize and spellcheck are off.

import { useRef, type ChangeEvent, type CompositionEvent, type KeyboardEvent, type Ref } from 'react';
import { imeConvert } from '../../../srs/romaji.ts';

export function KanaInput({ id, value, onChange, onSubmit, katakana = false, readOnly = false, placeholder = 'Type in romaji or kana',
  className, inputRef, describedBy, label }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter (never while composing). */
  onSubmit?: () => void;
  katakana?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  describedBy?: string;
  /** Accessible name when there is no visible <label>. */
  label?: string;
}) {
  const composing = useRef(false);
  const convert = (raw: string) => imeConvert(raw, { katakana });

  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const native = e.nativeEvent as InputEvent;
    // Mid-composition the IME owns the text: converting it would fight the candidate window.
    if (composing.current || native.isComposing) onChange(e.target.value);
    else onChange(convert(e.target.value));
  };
  const compositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    composing.current = false;
    onChange(convert(e.currentTarget.value));
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // keyCode 229: Safari's Enter that confirms an IME candidate.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSubmit?.();
  };

  return (
    <input ref={inputRef} id={id} className={className ? `text-input st-kana-input ${className}` : 'text-input st-kana-input'}
      value={value} lang="ja" inputMode="text" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
      enterKeyHint="done" placeholder={placeholder} readOnly={readOnly} aria-describedby={describedBy} aria-label={label}
      onChange={change} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={compositionEnd}
      onKeyDown={keyDown} />
  );
}
