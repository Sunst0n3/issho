import type { WordInfo } from '../../../lib/data.ts';
import type { AccentInfo } from '../../../lib/types.ts';
import { Ruby } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { useAutoPlay } from '../cards/parts.tsx';
import { PitchLine } from '../PitchLine.tsx';
import { wordRuby } from './data.ts';

/**
 * A new word made of kanji the learner already knows ("known kanji, new word"), or the spelling of a word they
 * already know by ear ("You know げんき — here is how it is written: 元気").
 */
export function StagedWordLesson({ word, accent, upgrade, onNext }: {
  word: WordInfo;
  accent?: AccentInfo;
  upgrade: boolean;
  onNext: () => void;
}) {
  useAutoPlay({ ref: word.ref }, { fallbackText: wordRuby(word) });
  return (
    <>
      <article className="card st-lesson st-lesson-kana">
        <p className="label">{upgrade ? 'New spelling' : 'Known kanji, new word'}</p>
        {upgrade && (
          <p className="st-upgrade">
            You know <span lang="ja">{word.kana}</span> — here is how it is written:
          </p>
        )}
        <Ruby text={wordRuby(word)} className="st-big st-lesson-word" show="all" />
        {accent && <PitchLine accent={accent} kana={word.kana} />}
        <h2 className="st-lesson-meaning">{word.en}</h2>
        <AudioButton source={{ ref: word.ref }} fallbackText={wordRuby(word)} label="Listen" />
      </article>
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={onNext}>Got it</button>
      </div>
    </>
  );
}
