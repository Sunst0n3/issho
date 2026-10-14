import { WriteQuestion } from './WriteQuestion.tsx';
import type { CardProps } from './types.ts';

/** What to write, as plain text for a writing pad's name: 'the kanji for "day" (ひ)'. */
export function kanjiTargetLabel(meaning: string, reading?: string): string {
  return `the kanji for "${meaning}"${reading ? ` (${reading})` : ''}`;
}

/** meaning + a reading → draw the kanji from memory */
export function KanjiWriteCard({ prepared, onAnswer, practice }: CardProps<'kanji-write'>) {
  const { kanji, reading, card } = prepared;
  return (
    <WriteQuestion card={card} char={kanji.char} ask="Write the kanji for" practice={practice}
      target={<>{kanji.meanings[0]} {reading && <span lang="ja" className="st-write-reading">{reading}</span>}</>}
      label={kanjiTargetLabel(kanji.meanings[0], reading)}
      note={kanji.meanings.join(', ')} speak={reading || undefined} onAnswer={onAnswer} />
  );
}
