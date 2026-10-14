import { WriteQuestion } from './WriteQuestion.tsx';
import type { CardProps } from './types.ts';

/** What to write for a kana: its romaji, and its row when the romaji alone is ambiguous. */
export function KanaTarget({ romaji, row }: { romaji: string; row?: string }) {
  return (
    <>
      <span className="st-write-romaji">{romaji}</span>
      {row && <span className="st-write-reading">(<span lang="ja">{row}</span> row)</span>}
    </>
  );
}

/** romaji → draw the kana */
export function KanaWriteCard({ prepared, onAnswer, practice }: CardProps<'kana-write'>) {
  const { kana, row, card } = prepared;
  return (
    <WriteQuestion card={card} char={kana.char} ask={`Write the ${kana.script} for`} practice={practice}
      target={<KanaTarget romaji={kana.romaji} row={row} />} speak={kana.char} onAnswer={onAnswer} />
  );
}
