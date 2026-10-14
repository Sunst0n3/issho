import { useState } from 'react';
import { useRubyShow } from '../../../lib/hooks.ts';
import type { GrammarPoint } from '../../../lib/types.ts';
import { SpeakButton } from '../../SpeakButton.tsx';
import { Ruby } from '../../ui.tsx';
import { DrillPractice } from '../DrillPractice.tsx';
import { grammarGloss } from '../format.ts';
import { MixedText } from '../MixedText.tsx';

/** Pattern, explanation and examples of a grammar point. */
export function GrammarExplainer({ point }: { point: GrammarPoint }) {
  const show = useRubyShow();
  return (
    <>
      <article className="card st-lesson">
        <p className="label">Grammar</p>
        <h2 className="st-pattern"><Ruby text={point.pattern} show={show} /></h2>
        <p className="st-lesson-title"><MixedText text={grammarGloss(point)} /></p>
        <p className="st-explanation"><MixedText text={point.explanation} /></p>
      </article>
      {point.examples.length > 0 && (
        <section className="st-section">
          <h3 className="label">Examples</h3>
          <ul className="card st-examples-list">
            {point.examples.map((ex) => (
              <li key={ex.jp}>
                <span className="st-example-text">
                  <Ruby className="st-example-jp" text={ex.jp} show={show} />
                  <span className="st-word-en"><MixedText text={ex.en} /></span>
                </span>
                <SpeakButton text={ex.jp} compact label="Listen to this example" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Two ungraded practice drills follow the explanation. */
export const LESSON_DRILLS = 2;

export function GrammarLesson({ point, onNext }: { point: GrammarPoint; onNext: () => void }) {
  const [practicing, setPracticing] = useState(false);
  const drills = point.drills.slice(0, LESSON_DRILLS);
  if (practicing) return <DrillPractice drills={drills} onDone={onNext} doneLabel="Done" />;
  return (
    <>
      <GrammarExplainer point={point} />
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={() => (drills.length ? setPracticing(true) : onNext())}>
          {drills.length ? 'Try it' : 'Got it'}
        </button>
      </div>
    </>
  );
}
