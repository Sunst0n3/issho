import { gradeFor } from '../../../srs/answers.ts';
import { Glyph } from '../../Glyph.tsx';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** radical → its meaning */
export function RadicalMeaningCard({ prepared, onAnswer }: CardProps<'radical-meaning'>) {
  const { radical, options } = prepared;
  const note = radical.variantOf ? `${radical.name}, a form of ${radical.variantOf}` : radical.name;
  return (
    <>
      <Question ask="What does this part mean?">
        <div className="st-big-glyph"><Glyph char={radical.char} size={96} /></div>
      </Question>
      <AnswerArea options={options} answer={radical.meaning}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: { expected: radical.meaning, note },
        })} />
    </>
  );
}
