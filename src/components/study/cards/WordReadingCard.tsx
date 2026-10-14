import { gradeFor, kanaMatches } from '../../../srs/answers.ts';
import { longVowelsSpelledOut } from '../format.ts';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** written word → kana (choice, or typed with live romaji → kana) */
export function WordReadingCard({ prepared, onAnswer }: CardProps<'word-reading'>) {
  const { word, options, breakdown } = prepared;
  return (
    <>
      <Question ask="How do you read this word?">
        <p className="st-big st-fit" lang="ja" style={fitStyle(word.written)}>{word.written}</p>
      </Question>
      <AnswerArea options={options} answer={word.kana} lang="ja"
        typed={{ view: 'word-reading', kind: 'kana', label: 'Reading', check: (s) => kanaMatches(s, [word.kana, longVowelsSpelledOut(word.kana)]) }}
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: { expected: word.kana, expectedLang: 'ja', note: word.meanings.join('; '), breakdown, speak: word.kana },
        })} />
    </>
  );
}
