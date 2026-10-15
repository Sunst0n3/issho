import { clipRef } from '../../../../shared/voicevox.ts';
import { AudioButton } from '../AudioButton.tsx';
import { useAutoPlay } from './parts.tsx';
import type { CardProps } from './types.ts';
import { WriteQuestion } from './WriteQuestion.tsx';

/**
 * Sound → write the kana. During the sprint the prompt is the sound only (played at once, with a replay button):
 * never a romaji label. After it, the kana's example word with the kana as □, its English and its audio.
 */
export function KanaWriteCard({ prepared, onAnswer, paperAllowed }: CardProps<'kana-write'>) {
  const { kana, prompt, word, blanked, row } = prepared;
  const sound = prompt === 'sound';
  useAutoPlay(sound ? { ref: clipRef.kana(kana.char) } : null, { fallbackText: kana.char });
  const target = sound ? (
    <div className="st-row st-center">
      <AudioButton source={{ ref: clipRef.kana(kana.char) }} fallbackText={kana.char} label="Play the sound" />
      {row && <span className="st-write-reading">(<span lang="ja">{row}</span> row)</span>}
    </div>
  ) : (
    <div className="st-row st-center">
      <span lang="ja">{blanked}</span>
      {word && <span className="st-write-en">· {word.en}</span>}
      {word && <AudioButton compact source={{ ref: clipRef.kanaEx(kana.char) }} fallbackText={word.kana} label={`Listen to ${blanked}`} />}
    </div>
  );
  return (
    <WriteQuestion char={kana.char} ask={sound ? `Write the ${kana.script} you hear` : `Write the missing ${kana.script}`}
      target={target} label={sound ? `the ${kana.script} you hear` : `the missing ${kana.script} in ${blanked}`}
      paperAllowed={paperAllowed} onAnswer={onAnswer} />
  );
}
