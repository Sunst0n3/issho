import { gradeFor, kanaMatches, romajiMatches } from '../../../srs/answers.ts';
import { AnswerArea, fitStyle, Question } from './parts.tsx';
import { BLANK } from './prepare.ts';
import type { CardProps } from './types.ts';

/** The word with the kana being asked marked, so the eye goes to it (か in かさ). */
function Marked({ word, char }: { word: string; char: string }) {
  const at = word.indexOf(char);
  if (at < 0 || word === char) return <>{word}</>;
  return <>{word.slice(0, at)}<span className="st-mark">{char}</span>{word.slice(at + char.length)}</>;
}

/**
 * During the sprint: kana → type its sound in letters (romaji is only the typing method here). After it: the kana
 * inside a short real word → type the word's reading through the IME.
 */
export function KanaReadCard({ prepared, onAnswer, handsBusy }: CardProps<'kana-read'>) {
  const { kana, mode, word, options, answer } = prepared;
  const result = (r: { correct: boolean; retries: number; mode: 'typed' | 'choice' }) => onAnswer({
    grade: gradeFor({ correct: r.correct, retries: r.retries, choice: r.mode === 'choice' }),
    mode: r.mode,
  });
  if (mode === 'romaji') {
    return (
      <>
        <Question ask={`What sound is this ${kana.script}?`}>
          <p className="st-big st-big-kana" lang="ja">{kana.char}</p>
        </Question>
        <AnswerArea options={options} answer={answer} handsBusy={handsBusy}
          typed={{ kind: 'romaji', label: 'The sound', check: (s) => romajiMatches(s, kana) }} onResult={result} />
      </>
    );
  }
  const shown = word?.kana ?? kana.char;
  return (
    <>
      <Question ask="Read this word">
        <p className="st-big st-fit" lang="ja" style={fitStyle(shown)}><Marked word={shown} char={kana.char} /></p>
        {word && <p className="st-translation">{word.en}</p>}
      </Question>
      <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
        typed={{ kind: 'kana', label: 'Reading', katakana: kana.script === 'katakana', check: (s) => !s.includes(BLANK) && kanaMatches(s, shown) }}
        onResult={result} />
    </>
  );
}
