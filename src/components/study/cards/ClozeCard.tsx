import { useCardRubyShow } from '../../../lib/hooks.ts';
import { gradeFor, kanaMatches } from '../../../srs/answers.ts';
import { Ruby } from '../../ui.tsx';
import { AnswerArea, Question } from './parts.tsx';
import { writtenMatches } from './prepare.ts';
import type { CardProps } from './types.ts';

/** A saved sentence with one word blanked, and its English → type the missing word's reading. */
export function ClozeCard({ prepared, onAnswer, handsBusy }: CardProps<'cloze'>) {
  const { sentence, cue, options, answer } = prepared;
  const show = useCardRubyShow();
  return (
    <>
      <Question ask="Fill the gap">
        <p className="st-sentence" lang="ja">
          <Ruby text={cue.before} show={show} />
          <span className="st-gap"><span className="visually-hidden">blank</span></span>
          <Ruby text={cue.after} show={show} />
        </p>
        {sentence.en && <p className="st-translation">{sentence.en}</p>}
      </Question>
      <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
        typed={{
          kind: 'kana',
          label: 'The missing word',
          check: (s) => kanaMatches(s, sentence.blank.reading) || writtenMatches(s, [{ written: sentence.blank.surface, readings: [sentence.blank.reading] }]),
        }}
        onResult={(r) => onAnswer({ grade: gradeFor({ correct: r.correct, retries: r.retries, choice: r.mode === 'choice' }), mode: r.mode })} />
    </>
  );
}
