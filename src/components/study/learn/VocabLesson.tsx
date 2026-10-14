import { useSettings } from '../../../lib/hooks.ts';
import type { KanaEntry, SurvivalWord } from '../../../lib/types.ts';
import { SpeakButton } from '../../SpeakButton.tsx';
import { fitStyle } from '../cards/parts.tsx';
import { kanaToRomaji } from '../format.ts';

export function VocabLesson({ vocab, kana, onNext }: { vocab: SurvivalWord; kana: readonly KanaEntry[]; onNext: () => void }) {
  const { romaji } = useSettings();
  return (
    <>
      <article className="card st-lesson st-lesson-kana">
        <p className="label">New word</p>
        <p className="st-big st-fit" lang="ja" style={fitStyle(vocab.kana)}>{vocab.kana}</p>
        {romaji && <p className="st-romaji">{kanaToRomaji(vocab.kana, kana)}</p>}
        <h2 className="st-lesson-meaning">{vocab.en}</h2>
        <SpeakButton text={vocab.kana} />
        {vocab.note && <p className="st-note">{vocab.note}</p>}
      </article>
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={onNext}>Got it</button>
      </div>
    </>
  );
}
