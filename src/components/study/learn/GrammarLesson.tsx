// A grammar point in five short steps: try to say it (10 s, English shown), one screen of explanation, three examples
// with audio and their phrase pitch, two comprehension taps and one build with tiles. Nothing here is graded.

import { useEffect, useMemo, useState } from 'react';
import { clipRef } from '../../../../shared/voicevox.ts';
import { useCardRubyShow, useRubyShow } from '../../../lib/hooks.ts';
import type { ClipAccentPhrase, GrammarPoint } from '../../../lib/types.ts';
import { Ruby } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { KanaText } from '../cards/KanaText.tsx';
import { tilesMatch } from '../cards/GrammarBuildCard.tsx';
import { piecesRuby, shuffleTiles } from '../cards/prepare.ts';
import { DrillPractice } from '../DrillPractice.tsx';
import { grammarGloss } from '../format.ts';
import { MixedText } from '../MixedText.tsx';
import { PhrasePitchLine } from '../PhrasePitchLine.tsx';

/** Seconds to try saying the first example before it is shown. */
export const TRY_SECONDS = 10;
/** Two ungraded comprehension taps follow the examples. */
export const LESSON_DRILLS = 2;
/** The lesson shows examples 0–2; reviews rotate through the rest. */
export const LESSON_EXAMPLES = 3;

/** Pattern, register, explanation and examples of a grammar point (the lesson and the grammar page). */
export function GrammarExplainer({ point, examples = point.examples, examplePitch = [] }: {
  point: GrammarPoint;
  examples?: GrammarPoint['examples'];
  examplePitch?: readonly (ClipAccentPhrase[] | undefined)[];
}) {
  const show = useRubyShow();
  return (
    <>
      <article className="card st-lesson">
        <p className="label">Grammar{point.register !== 'both' ? ` · ${point.register}` : ''}</p>
        <h2 className="st-pattern"><Ruby text={point.pattern} show={show} /></h2>
        <p className="st-lesson-title"><MixedText text={grammarGloss(point)} /></p>
        <p className="st-explanation"><MixedText text={point.explanation} /></p>
      </article>
      {examples.length > 0 && (
        <section className="st-section">
          <h3 className="label">Examples</h3>
          <ul className="card st-examples-list">
            {examples.map((ex, n) => (
              <li key={ex.jp}>
                <span className="st-example-text">
                  <KanaText className="st-example-jp" text={ex.jp} show={show} />
                  {examplePitch[n] && <PhrasePitchLine phrases={examplePitch[n]!} text={ex.jp} />}
                  <span className="st-word-en"><MixedText text={ex.en} /></span>
                </span>
                <AudioButton compact source={{ ref: clipRef.grammarExample(point.id, point.examples.indexOf(ex)) }} fallbackText={ex.jp}
                  label="Listen to this example" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** "Try to say it": the English of the first example, a 10-second countdown, then the Japanese with audio. */
function TryToSay({ point, onNext }: { point: GrammarPoint; onNext: () => void }) {
  const [left, setLeft] = useState(TRY_SECONDS);
  const example = point.examples[0];
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const revealed = left <= 0;
  return (
    <>
      <section className="st-question">
        <h2 className="st-ask">How would you say this?</h2>
        <div className="card st-prompt">
          <p className="st-english"><MixedText text={example.en} /></p>
          {revealed ? (
            <>
              <KanaText className="st-sentence" text={example.jp} />
              <AudioButton compact source={{ ref: clipRef.grammarExample(point.id, 0) }} fallbackText={example.jp} label="Listen" />
            </>
          ) : (
            <p className="st-note" aria-live="off">Say it out loud if you can — a guess is fine. {left} s</p>
          )}
        </div>
      </section>
      <div className="st-footer">
        {revealed ? (
          <button type="button" className="btn ink st-grow" onClick={onNext}>See how it works</button>
        ) : (
          <button type="button" className="btn secondary st-grow" onClick={() => setLeft(0)}>Show me</button>
        )}
      </div>
    </>
  );
}

/** One ungraded build with tiles, never dealt in the answer's order: tap the pieces in order; the answer shows either way. */
export function BuildPractice({ point, index = 0, onDone, doneLabel = 'Done' }: {
  point: GrammarPoint;
  index?: number;
  onDone: () => void;
  doneLabel?: string;
}) {
  const item = point.buildItems[index];
  const tiles = useMemo(() => (item ? shuffleTiles(item.tiles, Math.random) : []), [item]);
  // Tiles carry furigana over kanji the learner hasn't met, as on the review card; the plain tile is what is checked.
  const rubies = useMemo(() => (item ? piecesRuby(item.jp, item.tiles) : []), [item]);
  const show = useCardRubyShow();
  const [placed, setPlaced] = useState<number[]>([]);
  const [checked, setChecked] = useState<boolean | null>(null);
  if (!item) return null;
  const built = placed.map((i) => tiles[i]);
  const tile = (t: string) => <Ruby text={rubies[item.tiles.indexOf(t)] ?? t} show={show} />;
  return (
    <>
      <section className="st-question">
        <h2 className="st-ask">Build it</h2>
        <div className="card st-prompt">
          <p className="st-english"><MixedText text={item.en} /></p>
        </div>
      </section>
      <div className="st-tiles">
        <p className={checked === null ? 'st-built' : checked ? 'st-built good' : 'st-built bad'} lang="ja" aria-live="polite">
          {built.length ? built.map((t, k) => (
            <button key={k} type="button" className="st-tile placed" disabled={checked !== null}
              onClick={() => setPlaced(placed.filter((_, j) => j !== k))} aria-label={`Remove ${t}`}>{tile(t)}</button>
          )) : <span className="st-built-empty">Tap the pieces in order</span>}
        </p>
        <div className="st-tile-tray" role="group" aria-label="Pieces">
          {tiles.map((t, i) => (
            <button key={i} type="button" className="st-tile" lang="ja" disabled={placed.includes(i) || checked !== null}
              onClick={() => setPlaced([...placed, i])}>{tile(t)}</button>
          ))}
        </div>
      </div>
      {checked !== null && (
        <div className={checked ? 'feedback good' : 'feedback bad'} role="status">
          <p className="st-fb-title">{checked ? 'Right' : 'Here it is'}</p>
          <KanaText text={item.jp} />
        </div>
      )}
      <div className="st-footer">
        {checked === null ? (
          <button type="button" className="btn ink st-grow" disabled={placed.length !== tiles.length}
            onClick={() => setChecked(tilesMatch(built, item))}>Check</button>
        ) : (
          <>
            <AudioButton compact source={{ ref: clipRef.grammarBuild(point.id, index) }} fallbackText={item.jp} label="Listen" />
            <button type="button" className="btn ink st-grow" onClick={onDone}>{doneLabel}</button>
          </>
        )}
      </div>
    </>
  );
}

type Step = 'try' | 'explain' | 'drills' | 'build';

export function GrammarLesson({ point, examplePitch = [], onNext }: {
  point: GrammarPoint;
  examplePitch?: readonly (ClipAccentPhrase[] | undefined)[];
  onNext: () => void;
}) {
  const [step, setStep] = useState<Step>(point.examples.length ? 'try' : 'explain');
  const drills = point.drills.slice(0, LESSON_DRILLS);
  const afterExplain = () => (drills.length ? setStep('drills') : point.buildItems.length ? setStep('build') : onNext());
  const afterDrills = () => (point.buildItems.length ? setStep('build') : onNext());

  switch (step) {
    case 'try':
      return <TryToSay point={point} onNext={() => setStep('explain')} />;
    case 'explain':
      return (
        <>
          <GrammarExplainer point={point} examples={point.examples.slice(0, LESSON_EXAMPLES)} examplePitch={examplePitch} />
          <div className="st-footer">
            <button type="button" className="btn ink st-grow" onClick={afterExplain}>Try it</button>
          </div>
        </>
      );
    case 'drills':
      return <DrillPractice drills={drills} onDone={afterDrills} doneLabel="Next" />;
    case 'build':
      return <BuildPractice point={point} onDone={onNext} />;
  }
}
