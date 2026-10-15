import { gradeFor, kanaMatches } from '../../../srs/answers.ts';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** A practice word of a kana rule (が, きゃ, ファ …) → type its reading. */
export function KanaRuleCard({ prepared, onAnswer, handsBusy }: CardProps<'kana-rule'>) {
  const { rule, word, options, answer } = prepared;
  return (
    <>
      <Question ask="Read this word">
        <p className="st-big st-fit" lang="ja" style={fitStyle(word.kana)}>{word.kana}</p>
        <p className="st-translation">{word.en}</p>
      </Question>
      <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
        typed={{ kind: 'kana', label: 'Reading', katakana: rule.script === 'katakana', check: (s) => kanaMatches(s, word.kana) }}
        onResult={(r) => onAnswer({ grade: gradeFor({ correct: r.correct, retries: r.retries, choice: r.mode === 'choice' }), mode: r.mode })} />
    </>
  );
}
