// Grammar drills: a sentence with one gap (＿＿) and options to fill it.

import { Fragment, useMemo, useState } from 'react';
import { useRubyShow } from '../../lib/hooks.ts';
import type { GrammarDrill } from '../../lib/types.ts';
import { shuffle } from '../../srs/answers.ts';
import { SpeakButton } from '../SpeakButton.tsx';
import { Ruby } from '../ui.tsx';
import { ChoiceGrid } from './cards/parts.tsx';

export const GAP = '＿＿';

/** The drill sentence with its gap filled in. */
export function filledDrill(drill: GrammarDrill, option = drill.options[drill.answer]): string {
  return drill.prompt.replace(GAP, option);
}

/** The drill sentence with an empty (or filled) gap. */
export function DrillSentence({ prompt, fill, className }: { prompt: string; fill?: string; className?: string }) {
  const show = useRubyShow();
  const parts = prompt.split(GAP);
  return (
    <p className={className ? `st-drill-sentence ${className}` : 'st-drill-sentence'} lang="ja">
      {parts.map((part, i) => (
        <Fragment key={i}>
          <Ruby text={part} show={show} />
          {i < parts.length - 1 && (
            <span className={fill ? 'st-gap filled' : 'st-gap'}>
              {fill ?? <span className="visually-hidden">blank</span>}
            </span>
          )}
        </Fragment>
      ))}
    </p>
  );
}

/** Ungraded drill practice with immediate feedback, one drill at a time. */
export function DrillPractice({ drills, onDone, doneLabel = 'Done' }: {
  drills: readonly GrammarDrill[];
  onDone?: () => void;
  doneLabel?: string;
}) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const drill = drills[index];
  const options = useMemo(() => (drill ? shuffle(drill.options) : []), [drill]);
  if (!drill) return null;

  const answer = drill.options[drill.answer];
  const last = index === drills.length - 1;
  const next = () => {
    if (last) {
      onDone?.();
      return;
    }
    setIndex(index + 1);
    setPicked(null);
  };

  return (
    <div className="st-drill">
      <p className="label">Practice {index + 1} / {drills.length}</p>
      <div className="card st-prompt st-drill-card">
        <p className="st-drill-en">{drill.en}</p>
        <DrillSentence prompt={drill.prompt} fill={picked ?? undefined} />
      </div>
      <ChoiceGrid options={options} answer={answer} picked={picked} onPick={setPicked} lang="ja" />
      {picked !== null && (
        <>
          <div className={picked === answer ? 'feedback good' : 'feedback bad'} role="status">
            <p className="st-fb-title">
              {picked === answer ? 'Right' : <>Not quite: it's <span lang="ja">{answer}</span></>}
            </p>
            {picked !== answer && <Ruby className="st-fb-note" text={filledDrill(drill)} show="all" />}
          </div>
          <div className="st-row">
            <SpeakButton text={filledDrill(drill)} compact />
            {(onDone || !last) && (
              <button type="button" className="btn ink st-grow" onClick={next}>{last ? doneLabel : 'Next'}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
