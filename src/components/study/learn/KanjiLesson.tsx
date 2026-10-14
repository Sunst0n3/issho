import { useId, useState } from 'react';
import type { KanaEntry, KanjiEntry, WordEntry } from '../../../lib/types.ts';
import { StrokeOrderStrip } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { Glyph } from '../../Glyph.tsx';
import { SpeakButton } from '../../SpeakButton.tsx';
import { Icon } from '../../ui.tsx';
import { cleanReading } from '../format.ts';
import { Readings } from './Readings.tsx';

export const MNEMONIC_MAX = 160;

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

  if (editing) {
    return (
      <form className="st-hook" onSubmit={(e) => { e.preventDefault(); onChange(draft.trim()); setEditing(false); }}>
        <label className="label" htmlFor={id}>Your memory hook</label>
        <textarea id={id} className="text-input st-hook-input" value={draft} maxLength={MNEMONIC_MAX} rows={2}
          onChange={(e) => setDraft(e.target.value)} />
        <div className="st-row">
          <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" className="btn ink small">Save</button>
        </div>
      </form>
    );
  }
  if (!text) {
    return (
      <button type="button" className="btn ghost small st-center" onClick={() => setEditing(true)}>
        <Icon name="plus" size={16} />Add your own memory hook
      </button>
    );
  }
  return (
    <section className="st-hook">
      <div className="st-row">
        <h3 className="label st-grow">Memory hook</h3>
        <button type="button" className="btn ghost small" onClick={() => setEditing(true)} aria-label="Edit memory hook">Edit</button>
      </div>
      <p>{text}</p>
    </section>
  );
}

export function KanjiLesson({ kanji, words, mnemonic, kana, onHookChange, onPractice }: {
  kanji: KanjiEntry;
  words: readonly WordEntry[];
  mnemonic?: string;
  kana: readonly KanaEntry[];
  onHookChange: (text: string) => void;
  onPractice: () => void;
}) {
  const [hook, setHook] = useState(mnemonic);
  const reading = kanji.kun[0] ? cleanReading(kanji.kun[0]) : kanji.on[0];
  return (
    <>
      <article className="card st-lesson">
        <div className="st-lesson-head">
          <div className="st-glyph-box"><Glyph char={kanji.char} size={104} /></div>
          <div className="st-lesson-gloss">
            <h2 className="st-lesson-meaning">{kanji.meanings[0]}</h2>
            {kanji.meanings.length > 1 && <p className="muted">{kanji.meanings.slice(1).join(', ')}</p>}
            {reading && <SpeakButton text={reading} />}
          </div>
        </div>
        <Readings kun={kanji.kun} on={kanji.on} kana={kana} />
      </article>

      <StrokeOrderSection char={kanji.char} />
      <MemoryHook text={hook} onChange={(text) => { setHook(text || mnemonic); onHookChange(text); }} />

      {words.length > 0 && (
        <section className="st-section">
          <h3 className="label">Words with <span lang="ja">{kanji.char}</span></h3>
          <ul className="card st-words">
            {words.map((w) => (
              <li key={w.id}>
                <span className="st-word-written" lang="ja">{w.written}</span>
                <span className="st-word-text">
                  <span className="st-word-kana" lang="ja">{w.kana}</span>
                  <span className="st-word-en">{w.meanings.slice(0, 2).join('; ')}</span>
                </span>
                <SpeakButton text={w.kana} compact label={`Listen to ${w.kana}`} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onPractice}>
          <Icon name="pen" size={20} />Practice writing it
        </button>
      </div>
    </>
  );
}
