import { AudioButton } from '../AudioButton.tsx';
import type { CardProps } from './types.ts';
import { WriteQuestion } from './WriteQuestion.tsx';

/** What to write, as plain text for a writing pad's name: 'the kanji for "day"'. */
export function kanjiTargetLabel(meaning: string): string {
  return `the kanji for "${meaning}"`;
}

/** keyword + the anchor word with the kanji as □ and its reading (day · □本 にほん) → write the kanji from memory */
export function KanjiWriteCard({ prepared, onAnswer, paperAllowed }: CardProps<'kanji-write'>) {
  const { kanji, anchor, blanked, reading } = prepared;
  const target = (
    <div className="st-row st-center st-write-cue">
      <span className="st-write-keyword">{kanji.meanings[0]}</span>
      {blanked && <span lang="ja" className="st-write-blanked">· {blanked}</span>}
      {reading && <span lang="ja" className="st-write-reading">{reading}</span>}
      {anchor && <AudioButton compact source={{ ref: anchor.ref }} fallbackText={anchor.kana} label={`Listen to ${anchor.kana}`} />}
    </div>
  );
  return (
    <WriteQuestion char={kanji.char} ask="Write the kanji" target={target} label={kanjiTargetLabel(kanji.meanings[0])}
      paperAllowed={paperAllowed} onAnswer={onAnswer} />
  );
}
