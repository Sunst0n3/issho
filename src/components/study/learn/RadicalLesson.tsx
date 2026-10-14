import { useState } from 'react';
import type { KanjiEntry, RadicalEntry } from '../../../lib/types.ts';
import { Glyph } from '../../Glyph.tsx';
import { Icon } from '../../ui.tsx';
import { MemoryHook, StrokeOrderSection } from './KanjiLesson.tsx';

export function RadicalLesson({ radical, examples, mnemonic, onHookChange, onPractice }: {
  radical: RadicalEntry;
  examples: readonly KanjiEntry[];
  mnemonic?: string;
  onHookChange: (text: string) => void;
  onPractice: () => void;
}) {
  const [hook, setHook] = useState(mnemonic);
  return (
    <>
      <article className="card st-lesson">
        <p className="label">New part</p>
        <div className="st-lesson-head">
          <div className="st-glyph-box"><Glyph char={radical.char} size={104} /></div>
          <div className="st-lesson-gloss">
            <h2 className="st-lesson-meaning">{radical.meaning}</h2>
            {radical.name !== radical.meaning && <p className="muted">{radical.name}</p>}
          </div>
        </div>
        <p>
          {radical.variantOf
            ? <>A form of <span lang="ja" className="jp-display">{radical.variantOf}</span> used as a part of other kanji. Spotting it helps you guess their meaning.</>
            : 'A building block used in other kanji. Spotting it helps you guess their meaning.'}
        </p>
      </article>

      <MemoryHook text={hook} onChange={(text) => { setHook(text || mnemonic); onHookChange(text); }} />

      {examples.length > 0 && (
        <section className="st-section">
          <h3 className="label">Found in</h3>
          <ul className="st-examples">
            {examples.map((k) => (
              <li key={k.char} className="card">
                <Glyph char={k.char} size={40} />
                <span className="st-example-meaning">{k.meanings[0]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <StrokeOrderSection char={radical.char} />

      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onPractice}>
          <Icon name="pen" size={20} />Trace it
        </button>
      </div>
    </>
  );
}
