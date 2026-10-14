import { gradeFor, meaningMatches } from '../../../srs/answers.ts';
import { Glyph } from '../../Glyph.tsx';
import { cleanReading } from '../format.ts';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** kanji → English meaning */
export function KanjiMeaningCard({ prepared, onAnswer }: CardProps<'kanji-meaning'>) {
  const { kanji, options, notAccepted } = prepared;
  const readings = [...kanji.kun.map(cleanReading), ...kanji.on];
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
                {kanji.meanings.length > 1 && <span>{kanji.meanings.join(', ')}</span>}
                {readings.length > 0 && <span lang="ja">{readings.slice(0, 4).join('・')}</span>}
              </>
            ),
            speak: readings[0],
          },
        })} />
    </>
  );
}
