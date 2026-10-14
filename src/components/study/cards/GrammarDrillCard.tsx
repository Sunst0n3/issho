import { useState } from 'react';
import { gradeFor } from '../../../srs/answers.ts';
import { DrillSentence, filledDrill } from '../DrillPractice.tsx';
import { ChoiceGrid, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** a drill sentence with a gap → choose the missing part; the English is shown first */
export function GrammarDrillCard({ prepared, onAnswer }: CardProps<'grammar-drill'>) {
  const { point, drill, options } = prepared;
  const [picked, setPicked] = useState<string | null>(null);
  const answer = drill.options[drill.answer];

  const pick = (option: string) => {
    if (picked !== null) return;
    setPicked(option);
    const correct = option === answer;
    onAnswer({
      grade: gradeFor({ correct }),
      mode: 'choice',
      correct,
      feedback: { expected: answer, expectedLang: 'ja', note: point.title, speak: filledDrill(drill) },
    });
  };

  return (
    <>
      <Question ask="Fill the gap">
        <p className="st-drill-en">{drill.en}</p>
        <DrillSentence prompt={drill.prompt} fill={picked === null ? undefined : answer} />
      </Question>
      <ChoiceGrid options={options} answer={answer} picked={picked} onPick={pick} lang="ja" />
    </>
  );
}
