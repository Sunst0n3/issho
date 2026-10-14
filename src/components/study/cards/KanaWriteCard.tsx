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

/** What to write, as plain text for a writing pad's name: 'the hiragana for "ji" (ざ row)'. */
export function kanaTargetLabel(script: string, romaji: string, row?: string): string {
  return `the ${script} for "${romaji}"${row ? ` (${row} row)` : ''}`;
}

/** romaji → draw the kana */
export function KanaWriteCard({ prepared, onAnswer, practice }: CardProps<'kana-write'>) {
  const { kana, row, card } = prepared;
  return (
    <WriteQuestion card={card} char={kana.char} ask={`Write the ${kana.script} for`} practice={practice}
      target={<KanaTarget romaji={kana.romaji} row={row} />} label={kanaTargetLabel(kana.script, kana.romaji, row)}
      speak={kana.char} onAnswer={onAnswer} />
  );
}
