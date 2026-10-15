import { clipRef } from '../../../../shared/voicevox.ts';
import type { KanaExample } from '../../../lib/data.ts';
import type { KanaEntry } from '../../../lib/types.ts';
import { AudioButton } from '../AudioButton.tsx';
import { KanaText } from '../cards/KanaText.tsx';
import { useAutoPlay } from '../cards/parts.tsx';
import { Icon } from '../../ui.tsx';

/**
 * One kana of a row lesson: its sound (played at once), a one-line picture hook and a short real word with it. The
 * trace and the guided copy follow (NewItemFlow).
 */
export function KanaLesson({ kana, example, onPractice }: {
  kana: KanaEntry;
  example?: KanaExample;
  onPractice: () => void;
}) {
  useAutoPlay({ ref: clipRef.kana(kana.char) }, { fallbackText: kana.char });
  return (
    <>
      <article className="card st-lesson st-lesson-kana">
        <p className="label">New {kana.script}</p>
        <p className="st-kana-big" lang="ja">{kana.char}</p>
        <AudioButton source={{ ref: clipRef.kana(kana.char) }} fallbackText={kana.char} label="Hear it" />
        {example?.hook && <p className="st-kana-hook">{example.hook}</p>}
        {example && (
          <div className="st-example-word">
            <span className="st-example-text">
              <span className="label">In a word</span>
              <span>
                <KanaText text={example.kana} className="st-word-written" />
                {example.written && <span className="st-word-kana" lang="ja"> ({example.written})</span>}
              </span>
              <span className="st-word-en">{example.en}</span>
            </span>
            <AudioButton compact source={{ ref: clipRef.kanaEx(kana.char) }} fallbackText={example.kana} label={`Listen to ${example.kana}`} />
          </div>
        )}
      </article>
      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onPractice}>
          <Icon name="pen" size={20} />Trace it
        </button>
      </div>
    </>
  );
}
