import { useSettings } from '../../../lib/hooks.ts';
import type { KanaEntry } from '../../../lib/types.ts';
import { isYoon } from '../../../srs/items.ts';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { SpeakButton } from '../../SpeakButton.tsx';
import { Icon } from '../../ui.tsx';
import { kanaToRomaji } from '../format.ts';
import type { ExampleWord } from './data.ts';
import { StrokeOrderSection } from './KanjiLesson.tsx';

export function KanaLesson({ kana, example, all, onPractice, onNext }: {
  kana: KanaEntry;
  example?: ExampleWord;
  all: readonly KanaEntry[];
  /** Writing practice; yōon have none and go straight on. */
  onPractice: () => void;
  onNext: () => void;
}) {
  const { romaji } = useSettings();
  const yoon = isYoon(kana.char);
  const { strokes, loading } = useStrokes(yoon ? undefined : kana.char);
  const writable = !yoon && Boolean(strokes?.length);
  const [base, small] = [...kana.char];

  return (
    <>
      <article className="card st-lesson st-lesson-kana">
        <p className="label">New {kana.script}</p>
        <p className="st-kana-big" lang="ja">{kana.char}</p>
        <p className="st-lesson-meaning">{kana.romaji}</p>
        {yoon && (
          <p className="muted">
            <span lang="ja">{base}</span> and a small <span lang="ja">{small}</span> make one sound.
          </p>
        )}
        <SpeakButton text={kana.char} />
        {example && (
          <div className="st-example-word">
            <span className="st-example-text">
              <span className="label">Example</span>
              <span>
                <span className="st-word-written" lang="ja">{example.kana}</span>
                {romaji && <span className="st-romaji">{kanaToRomaji(example.kana, all, { particles: true })}</span>}
                {example.written && <span className="st-word-kana" lang="ja"> ({example.written})</span>}
              </span>
              <span className="st-word-en">{example.en}</span>
            </span>
            <SpeakButton text={example.kana} compact label={`Listen to ${example.kana}`} />
          </div>
        )}
      </article>

      {!yoon && <StrokeOrderSection char={kana.char} />}

      <div className="st-footer">
        {writable ? (
          <button type="button" className="btn primary st-grow" onClick={onPractice}>
            <Icon name="pen" size={20} />Practice writing it
          </button>
        ) : (
          <button type="button" className="btn ink st-grow" onClick={onNext} disabled={loading && !yoon}>Got it</button>
        )}
      </div>
    </>
  );
}
