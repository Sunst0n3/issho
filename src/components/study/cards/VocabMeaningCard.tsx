import { gradeFor } from '../../../srs/answers.ts';
import { MixedText } from '../MixedText.tsx';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** survival word in kana → English */
export function VocabMeaningCard({ prepared, onAnswer }: CardProps<'vocab-meaning'>) {
  const { vocab, options } = prepared;
  return (
    <>
      <Question ask="What does this mean?">
        <p className="st-big st-fit" lang="ja" style={fitStyle(vocab.kana)}>{vocab.kana}</p>
      </Question>
      <AnswerArea options={options} answer={vocab.en}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: { expected: vocab.en, note: vocab.note && <MixedText text={vocab.note} />, speak: vocab.kana },
        })} />
    </>
  );
}
