import { useState } from 'react';
import { rubyToPlain } from '../../../lib/ruby.ts';
import { gradeFor, sentenceMatches } from '../../../srs/answers.ts';
import { MixedText } from '../MixedText.tsx';
import { AnswerArea, Question } from './parts.tsx';
import type { CardProps } from './types.ts';

/** Spaces and sentence punctuation don't count when comparing a built sentence. */
const LOOSE = /[\s、。！？!?,.・「」]/gu;
const loose = (s: string) => s.replace(LOOSE, '');

/** A tile order is right when it spells the sentence or one of its accepted alternatives. */
export function tilesMatch(built: readonly string[], item: { jp: string; alternatives: readonly string[] }): boolean {
  const text = loose(built.join(''));
  return [rubyToPlain(item.jp), ...item.alternatives].some((t) => loose(t) === text);
}

/** Tap the tiles in order. One wrong order is a retry (Hard when it then comes right); a second is Again. */
function TileBuilder({ tiles, check, onResult }: {
  tiles: readonly string[];
  check: (built: string[]) => boolean;
  onResult: (r: { correct: boolean; retries: number }) => void;
}) {
  const [placed, setPlaced] = useState<number[]>([]);
  const [retries, setRetries] = useState(0);
  const [result, setResult] = useState<boolean | null>(null);
  const built = placed.map((i) => tiles[i]);
  const full = placed.length === tiles.length;

  const submit = () => {
    if (!full || result !== null) return;
    if (check(built)) {
      setResult(true);
      onResult({ correct: true, retries });
    } else if (retries === 0) {
      setRetries(1);
      setPlaced([]);
    } else {
      setResult(false);
      onResult({ correct: false, retries });
    }
  };

  return (
    <div className="st-tiles">
      <p className={result === null ? 'st-built' : result ? 'st-built good' : 'st-built bad'} lang="ja" aria-live="polite">
        {built.length ? built.map((t, k) => (
          <button key={k} type="button" className="st-tile placed" disabled={result !== null}
            onClick={() => setPlaced(placed.filter((_, j) => j !== k))} aria-label={`Remove ${t}`}>{t}</button>
        )) : <span className="st-built-empty">Tap the pieces in order</span>}
      </p>
      {retries > 0 && result === null && <p className="st-retry" role="status">Not quite. One more try.</p>}
      <div className="st-tile-tray" role="group" aria-label="Pieces">
        {tiles.map((t, i) => (
          <button key={i} type="button" className="st-tile" lang="ja" disabled={placed.includes(i) || result !== null}
            onClick={() => setPlaced([...placed, i])}>{t}</button>
        ))}
      </div>
      {result === null && (
        <div className="st-typed-actions">
          <button type="button" className="btn ghost small" onClick={() => { setResult(false); onResult({ correct: false, retries }); }}>
            I don't know
          </button>
          <button type="button" className="btn ink small" disabled={!full} onClick={submit}>Check</button>
        </div>
      )}
    </div>
  );
}

/**
 * English → build the Japanese: tiles while fewer than 60 grammar points are introduced, then typed (IME) against the
 * build-time answers (which include the は/わ, へ/え and を/お spellings).
 */
export function GrammarBuildCard({ prepared, onAnswer, handsBusy }: CardProps<'grammar-build'>) {
  const { point, item, tiles, shuffledTiles, options, answer } = prepared;
  return (
    <>
      <Question ask="Say this in Japanese">
        <p className="st-english"><MixedText text={item.en} /></p>
        <p className="st-note"><MixedText text={point.title} /></p>
      </Question>
      {tiles ? (
        <TileBuilder tiles={shuffledTiles} check={(built) => tilesMatch(built, item)}
          onResult={(r) => onAnswer({ grade: gradeFor(r), mode: 'typed' })} />
      ) : (
        <AnswerArea options={options} answer={answer} lang="ja" handsBusy={handsBusy}
          typed={{ kind: 'kana', label: 'Type the sentence', check: (s) => sentenceMatches(s, item.answers) }}
          onResult={(r) => onAnswer({ grade: gradeFor({ correct: r.correct, retries: r.retries, choice: r.mode === 'choice' }), mode: r.mode })} />
      )}
    </>
  );
}
