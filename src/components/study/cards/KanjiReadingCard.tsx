import { gradeFor } from '../../../srs/answers.ts';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** A word with the kanji highlighted, the target kanji underlined in shu. */
export function MarkedWord({ written, mark }: { written: string; mark: string }) {
  return (
    <p className="st-big st-fit" lang="ja" style={fitStyle(written)}>
      {[...written].map((ch, i) => (ch === mark ? <span key={i} className="st-target">{ch}</span> : ch))}
    </p>
  );
}

/** kanji inside a taught word → the word's kana */
export function KanjiReadingCard({ prepared, onAnswer }: CardProps<'kanji-reading'>) {
  const { kanji, word, answer, options, breakdown } = prepared;
  return (
    <>
      <Question ask={word ? 'How do you read this word?' : `Which is a reading of ${kanji.char}?`}>
        <MarkedWord written={word?.written ?? kanji.char} mark={kanji.char} />
      </Question>
      <AnswerArea options={options} answer={answer} lang="ja"
        onResult={(r) => onAnswer({
          grade: gradeFor(r),
          mode: r.mode,
          correct: r.correct,
          feedback: {
            expected: answer,
            expectedLang: 'ja',
            note: word ? word.meanings.join('; ') : kanji.meanings.join(', '),
            breakdown,
            speak: answer,
          },
        })} />
    </>
  );
}
