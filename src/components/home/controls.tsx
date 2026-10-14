// Small form controls shared by the home, settings and library screens.
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * One-of-n choice drawn as the .segmented track. A radio group: arrow keys move
 * and select, only the selected option is in the tab order.
 */
export function Segmented<T extends string>({ label, options, value, onChange, className }: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={className ? `segmented ${className}` : 'segmented'}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio"
          aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)} onKeyDown={(e) => onKeyDown(e, i)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off setting: a checkbox announced as a switch, with its label and an optional hint. */
export function Switch({ label, hint, checked, onChange, disabled }: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="hm-switch-row">
      <span className="hm-switch-text">
        <span id={`${id}-label`} className="hm-switch-label">{label}</span>
        {hint && <span id={`${id}-hint`} className="hm-switch-hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="hm-switch" checked={checked} disabled={disabled}
        aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
