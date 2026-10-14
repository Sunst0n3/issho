import { WriteQuestion } from './WriteQuestion.tsx';
import type { CardProps } from './types.ts';

/** meaning + a reading → draw the kanji from memory */
export function KanjiWriteCard({ prepared, onAnswer, practice }: CardProps<'kanji-write'>) {
  const { kanji, reading, card } = prepared;
  return (
    <WriteQuestion card={card} char={kanji.char} ask="Write the kanji for" practice={practice}
      target={<>{kanji.meanings[0]} {reading && <span lang="ja" className="st-write-reading">{reading}</span>}</>}
      note={kanji.meanings.join(', ')} speak={reading || undefined} onAnswer={onAnswer} />
  );
}
