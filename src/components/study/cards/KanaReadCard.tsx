import { gradeFor, romajiMatches } from '../../../srs/answers.ts';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** kana → romaji */
export function KanaReadCard({ prepared, onAnswer }: CardProps<'kana-read'>) {
  const { kana, options } = prepared;
  return (
    <>
      <Question ask={`What sound is this ${kana.script}?`}>
        <p className="st-big st-big-kana" lang="ja">{kana.char}</p>
      </Question>
      <AnswerArea options={options} answer={kana.romaji}
        typed={{ view: 'kana-read', kind: 'romaji', label: 'Romaji', check: (s) => romajiMatches(s, kana) }}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: { expected: kana.romaji, speak: kana.char },
        })} />
    </>
  );
}
