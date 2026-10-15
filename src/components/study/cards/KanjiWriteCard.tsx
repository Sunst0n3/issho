import { AudioButton } from '../AudioButton.tsx';
import { Blanked } from './parts.tsx';
import { blankKanji } from './prepare.ts';
import type { CardProps } from './types.ts';
import { WriteQuestion } from './WriteQuestion.tsx';

/** What to write, as plain text for a writing pad's name: 'the kanji for "day"'. */
export function kanjiTargetLabel(meaning: string): string {
  return `the kanji for "${meaning}"`;
}

/**
 * keyword + the anchor word with the kanji as □ and its reading (day · □本 にほん) → write the kanji from memory.
 * Leak guard (§3.2.4): while another card due today still asks the anchor's reading (its read or produce card), the
 * reading and the anchor's audio stay back; any other kanji of the anchor still to be written today is a □ too.
 */
export function KanjiWriteCard({ prepared, onAnswer, paperAllowed, mask }: CardProps<'kanji-write'>) {
  const { kanji, anchor, blanked, reading } = prepared;
  const readingAsked = Boolean(anchor && mask?.readings.has(anchor.ref));
  const cue = blanked && mask ? [...mask.kanji].reduce((b, k) => (k === kanji.char ? b : blankKanji(b, k)), blanked) : blanked;
  const target = (
    <div className="st-row st-center st-write-cue">
      <span className="st-write-keyword">{kanji.meanings[0]}</span>
      {cue && <span lang="ja" className="st-write-blanked">· <Blanked text={cue} /></span>}
      {reading && !readingAsked && <span lang="ja" className="st-write-reading">{reading}</span>}
      {anchor && !readingAsked && <AudioButton compact source={{ ref: anchor.ref }} fallbackText={anchor.kana} label={`Listen to ${anchor.kana}`} />}
    </div>
  );
  return (
    <WriteQuestion char={kanji.char} ask="Write the kanji" target={target} label={kanjiTargetLabel(kanji.meanings[0])}
      paperAllowed={paperAllowed} onAnswer={onAnswer} />
  );
}
