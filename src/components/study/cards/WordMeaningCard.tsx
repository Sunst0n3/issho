import { gradeFor } from '../../../srs/answers.ts';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** written word → English */
export function WordMeaningCard({ prepared, onAnswer }: CardProps<'word-meaning'>) {
  const { word, options, breakdown } = prepared;
  return (
    <>
      <Question ask="What does this word mean?">
        <p className="st-big st-fit" lang="ja" style={fitStyle(word.written)}>{word.written}</p>
      </Question>
      <AnswerArea options={options} answer={word.meanings[0]}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: {
            expected: word.meanings[0],
            note: <><span lang="ja">{word.kana}</span>{word.meanings.length > 1 && <span>{word.meanings.join('; ')}</span>}</>,
            breakdown,
            speak: word.kana,
          },
        })} />
    </>
  );
}
