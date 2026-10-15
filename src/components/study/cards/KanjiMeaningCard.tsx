import { useId, useState } from 'react';
import { selfGrade } from '../../../srs/answers.ts';
import { Glyph } from '../../Glyph.tsx';
import { cleanReading } from '../format.ts';
import { Question, SelfGrade } from './parts.tsx';
import type { CardProps } from './types.ts';

/**
 * Up to `max` readings with both kinds in: kun first, keeping room for the on
 * readings (赤: あか・あかい・セキ・シャク, not four kun readings and no セキ).
 */
export function readingSample(kun: readonly string[], on: readonly string[], max = 4): string[] {
  const kunShown = Math.min(kun.length, Math.max(max - on.length, Math.ceil(max / 2)));
  return [...kun.slice(0, kunShown).map(cleanReading), ...on.slice(0, max - kunShown)];
}

/** A kanji with no taught word: recall its meaning, reveal, then Missed / Got it. */
export function KanjiMeaningCard({ prepared, onAnswer }: CardProps<'kanji-meaning'>) {
  const { kanji } = prepared;
  const [revealed, setRevealed] = useState(false);
  const revealId = useId();
  const readings = readingSample(kanji.kun, kanji.on);
  return (
    <>
      <Question ask="What does this kanji mean?">
        <div className="st-big-glyph"><Glyph char={kanji.char} size={96} /></div>
        {revealed && (
          <div className="st-reveal" id={revealId}>
            <p className="st-english">{kanji.meanings.join(', ')}</p>
            {readings.length > 0 && <p className="st-reveal-kana" lang="ja">{readings.join('・')}</p>}
          </div>
        )}
      </Question>
      {revealed ? (
        <SelfGrade describedBy={revealId} onGrade={(gotIt) => onAnswer({ grade: selfGrade(gotIt), mode: 'self', revealed: true })} />
      ) : (
        <button type="button" className="btn ink block" onClick={() => setRevealed(true)}>Show the meaning</button>
      )}
    </>
  );
}
