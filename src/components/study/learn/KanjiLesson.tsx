import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KanjiEntry } from '../../../lib/types.ts';
import { StrokeOrderStrip } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { Glyph } from '../../Glyph.tsx';
import { Icon, Ruby } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { MixedText } from '../MixedText.tsx';
import { PitchLine } from '../PitchLine.tsx';
import { wordRuby, type LessonData, type PartInfo } from './data.ts';
import { Readings } from './Readings.tsx';

/** The longest memory hook, here and on the kanji page. */
export const MNEMONIC_MAX = 200;

/** Stroke order frames with their heading, or nothing while loading / without data. */
export function StrokeOrderSection({ char }: { char: string }) {
  const { strokes } = useStrokes(char);
  if (!strokes?.length) return null;
  const n = strokes.length;
  return (
    <section className="st-section">
      <h3 className="label">Stroke order · {n} {n === 1 ? 'stroke' : 'strokes'}</h3>
      <StrokeOrderStrip strokes={strokes} label={`Stroke order for ${char}`} />
    </section>
  );
}

/** The one-line memory hook (hidden when there is none), editable in place. */
export function MemoryHook({ text, onChange }: { text?: string; onChange: (text: string) => void }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text ?? '');
  // Focus follows the edit: into the box when it opens, back to the button when it closes.
  const input = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    if (editing) input.current?.focus();
    else opener.current?.focus();
  }, [editing]);
  const edit = (on: boolean) => {
    toggled.current = true;
    setEditing(on);
  };

  if (editing) {
    return (
      <form className="st-hook" onSubmit={(e) => { e.preventDefault(); onChange(draft.trim()); edit(false); }}>
        <label className="label" htmlFor={id}>Your memory hook</label>
        <textarea ref={input} id={id} className="text-input st-hook-input" value={draft} maxLength={MNEMONIC_MAX} rows={2}
          onChange={(e) => setDraft(e.target.value)} />
        <div className="st-row">
          <button type="button" className="btn ghost small" onClick={() => edit(false)}>Cancel</button>
          <button type="submit" className="btn ink small">Save</button>
        </div>
      </form>
    );
  }
  if (!text) {
    return (
      <button ref={opener} type="button" className="btn ghost small st-center" onClick={() => edit(true)}>
        <Icon name="plus" size={16} />Add your own memory hook
      </button>
    );
  }
  return (
    <section className="st-hook">
      <div className="st-row">
        <h3 className="label st-grow">Memory hook</h3>
        <button ref={opener} type="button" className="btn ghost small" onClick={() => edit(true)} aria-label="Edit memory hook">Edit</button>
      </div>
      <p>{text}</p>
    </section>
  );
}

/** The pre-guess lasts this long, then the meaning is revealed. */
export const PRE_GUESS_MS = 5000;

/** Its parts and their names: what might it mean? Ungraded; reveals itself after 5 s. */
function PreGuess({ kanji, parts, onReveal }: { kanji: KanjiEntry; parts: readonly PartInfo[]; onReveal: () => void }) {
  useEffect(() => {
    const t = setTimeout(onReveal, PRE_GUESS_MS);
    return () => clearTimeout(t);
  }, [onReveal]);
  return (
    <>
      <article className="card st-lesson">
        <p className="label">New kanji</p>
        <h2 className="st-lesson-meaning">What might it mean?</h2>
        <div className="st-glyph-box st-center"><Glyph char={kanji.char} size={84} /></div>
        <PartsPanel parts={parts} />
        <div className="st-timer" aria-hidden="true"><span style={{ animationDuration: `${PRE_GUESS_MS}ms` }} /></div>
      </article>
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={onReveal}>Show me</button>
      </div>
    </>
  );
}

/** Component kanji and named parts with their names: a plain list. */
export function PartsPanel({ parts }: { parts: readonly PartInfo[] }) {
  if (!parts.length) return null;
  return (
    <section className="st-section st-parts">
      <h3 className="label">Parts</h3>
      <ul className="st-parts-list">
        {parts.map((p) => (
          <li key={p.char}>
            <Glyph char={p.char} size={28} />
            <span className="st-part-name">{p.name || ' '}</span>
            {!p.known && <span className="chip st-chip-muted">new</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function KanjiLesson({ data, customMnemonic, onHookChange, onPractice }: {
  data: Extract<LessonData, { kind: 'kanji' }>;
  customMnemonic?: string;
  onHookChange: (text: string) => void;
  onPractice: () => void;
}) {
  const { kanji, unit, anchor, anchorAccent, mnemonic, parts, newPart } = data;
  const [guessing, setGuessing] = useState(Boolean(unit?.inferable && parts.length));
  const [hook, setHook] = useState(customMnemonic ?? mnemonic?.meaning);
  const reveal = useCallback(() => setGuessing(false), []);
  if (guessing) return <PreGuess kanji={kanji} parts={parts} onReveal={reveal} />;
  return (
    <>
      <article className="card st-lesson">
        <div className="st-lesson-head">
          <div className="st-glyph-box"><Glyph char={kanji.char} size={84} /></div>
          <div className="st-lesson-gloss">
            <h2 className="st-lesson-meaning">{kanji.meanings[0]}</h2>
            {kanji.meanings.length > 1 && <p className="muted">{kanji.meanings.slice(1).join(', ')}</p>}
            {kanji.jlptOld && <span className="chip st-chip-muted">Old JLPT {kanji.jlptOld}</span>}
          </div>
        </div>
        <PartsPanel parts={parts} />
        <Readings kun={kanji.kun} on={kanji.on} />
      </article>

      <MemoryHook text={hook} onChange={(text) => { setHook(text || mnemonic?.meaning); onHookChange(text); }} />

      {anchor && (
        <section className="st-section">
          <h3 className="label">Word</h3>
          <div className="card st-anchor">
            <span className="st-anchor-text">
              <Ruby text={wordRuby(anchor)} className="st-word-written" show="all" />
              {anchorAccent && <PitchLine accent={anchorAccent} kana={anchor.kana} size="sm" />}
              <span className="st-word-en">{anchor.en}</span>
              {mnemonic?.sound && <span className="st-note"><MixedText text={mnemonic.sound} /></span>}
            </span>
            <AudioButton compact source={{ ref: anchor.ref }} fallbackText={wordRuby(anchor)} label={`Listen to ${anchor.kana}`} />
          </div>
        </section>
      )}

      <StrokeOrderSection char={kanji.char} />

      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onPractice}>
          <Icon name="pen" size={20} />{newPart ? 'Trace it' : 'Copy it'}
        </button>
      </div>
    </>
  );
}
