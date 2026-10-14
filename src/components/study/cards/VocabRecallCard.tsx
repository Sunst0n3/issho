import { gradeFor } from '../../../srs/answers.ts';
import { MixedText } from '../MixedText.tsx';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** English → choose the survival word's kana */
export function VocabRecallCard({ prepared, onAnswer }: CardProps<'vocab-recall'>) {
  const { vocab, options } = prepared;
  return (
    <>
      <Question ask="How do you say this in Japanese?">
        <p className="st-english">{vocab.en}</p>
      </Question>
      <AnswerArea options={options} answer={vocab.kana} lang="ja"
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: { expected: vocab.kana, expectedLang: 'ja', note: vocab.note && <MixedText text={vocab.note} />, speak: vocab.kana },
        })} />
    </>
  );
}
