import { gradeFor, meaningMatches } from '../../../srs/answers.ts';
import { Glyph } from '../../Glyph.tsx';
import { cleanReading } from '../format.ts';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/**
 * Up to `max` readings with both kinds in: kun first, keeping room for the on
 * readings (赤: あか・あかい・セキ・シャク, not four kun readings and no セキ).
 */
export function readingSample(kun: readonly string[], on: readonly string[], max = 4): string[] {
  const kunShown = Math.min(kun.length, Math.max(max - on.length, Math.ceil(max / 2)));
  return [...kun.slice(0, kunShown).map(cleanReading), ...on.slice(0, max - kunShown)];
}

/** kanji → English meaning */
export function KanjiMeaningCard({ prepared, onAnswer }: CardProps<'kanji-meaning'>) {
  const { kanji, options, notAccepted } = prepared;
  const readings = readingSample(kanji.kun, kanji.on);
  return (
    <>
      <Question ask="What does this kanji mean?">
        <div className="st-big-glyph"><Glyph char={kanji.char} size={96} /></div>
      </Question>
      <AnswerArea options={options} answer={kanji.meanings[0]}
        typed={{
          view: 'kanji-meaning',
          kind: 'meaning',
          label: 'Meaning',
          check: (s) => meaningMatches(s, kanji.meanings, { notAccepted }),
        }}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: {
            expected: kanji.meanings[0],
            note: (
              <>
                {/* Always spelled out: a typed answer may have been accepted with a typo. */}
                <span>{kanji.meanings.join(', ')}</span>
                {readings.length > 0 && <span lang="ja">{readings.join('・')}</span>}
              </>
            ),
            speak: readings[0],
          },
        })} />
    </>
  );
}
