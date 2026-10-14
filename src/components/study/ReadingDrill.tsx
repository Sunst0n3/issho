// Read & shadow: one sentence at a time, a quick question about it, then the
// translation, listening, shadowing and (from phase 3) saving. Not graded.

import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useEffect, useRef, useState } from 'react';
import { db } from '../../lib/db.ts';
import { useRubyShow } from '../../lib/hooks.ts';
import { parseRuby } from '../../lib/ruby.ts';
import { currentPhase } from '../../srs/course.ts';
import { markSentencesShown } from '../../srs/planner.ts';
import { SpeakButton } from '../SpeakButton.tsx';
import { Icon } from '../ui.tsx';
import { ChoiceGrid } from './cards/parts.tsx';
import { prepareReading } from './readingQuestion.ts';
import { saveSentence, type SentenceLike } from './sentences.ts';
import { useFocusHeading, useScrollToTop } from './focus.ts';
import { Shadow } from './Shadow.tsx';
import { useAsync } from './useAsync.ts';

/** The sentence with ruby per the furigana setting; the target word underlined, its reading hidden until answered. */
export function SentenceText({ jp, target = -1, revealTarget = false }: { jp: string; target?: number; revealTarget?: boolean }) {
  const show = useRubyShow();
  return (
    <p className="st-sentence" lang="ja">
      {parseRuby(jp).map((seg, i) => {
        const isTarget = i === target;
        const visible = seg.reading !== undefined
          && (isTarget ? revealTarget : show === 'all' || (typeof show === 'function' && show(seg.text)));
        const text = visible ? <ruby>{seg.text}<rt>{seg.reading}</rt></ruby> : seg.text;
        return isTarget ? <span key={i} className="st-target">{text}</span> : <Fragment key={i}>{text}</Fragment>;
      })}
    </p>
  );
}

/** Saving sentences as review cards starts with phase 3, reading for real. */
const SAVE_FROM_PHASE = 3;

function SaveButton({ sentence }: { sentence: SentenceLike }) {
  const saved = useLiveQuery(() => db.savedSentences.get(sentence.id), [sentence.id]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (saved) {
    return (
      <button type="button" className="btn secondary small st-grow" disabled>
        <Icon name="check" size={16} />Saved for review
      </button>
    );
  }
  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await saveSentence(sentence);
    } catch (e) {
      console.error('could not save sentence', e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn secondary small st-grow" onClick={() => void save()} disabled={busy}>
      <Icon name="plus" size={16} />{failed ? 'Try saving again' : 'Save sentence'}
    </button>
  );
}

function SentenceStep({ sentence, last, doneLabel, canSave, onNext }: {
  sentence: SentenceLike;
  last: boolean;
  doneLabel: string;
  canSave: boolean;
  onNext: () => void;
}) {
  const question = useAsync(() => prepareReading(sentence), [sentence.id]);
  const [picked, setPicked] = useState<string | null>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useScrollToTop(sentence.id);
  useFocusHeading(root, question.loading);
  useEffect(() => {
    if (picked !== null) continueRef.current?.focus({ preventScroll: true });
  }, [picked]);

  if (question.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the sentence" />;
  const q = question.data;
  const answered = picked !== null || !q;
  const correct = q && picked === q.answer;

  return (
    <div className="st-reading" ref={root}>
      <section className="st-question">
        <h2 className="st-ask">
          {!q ? 'Read this sentence' : q.kind === 'reading' ? 'How do you read the underlined word?' : 'What does this mean?'}
        </h2>
        <div className="card st-prompt st-reading-card">
          <SentenceText jp={sentence.jp} target={q?.kind === 'reading' ? q.target : -1} revealTarget={answered} />
          {answered && <p className="st-translation">{sentence.en}</p>}
        </div>
      </section>

      {q && (
        <ChoiceGrid options={q.options} answer={q.answer} picked={picked} onPick={setPicked}
          lang={q.kind === 'reading' ? 'ja' : undefined} />
      )}

      {answered && (
        <>
          {q && (
            <div className={correct ? 'feedback good' : 'feedback bad'} role="status">
              <p className="st-fb-title">
                {correct ? 'Correct' : <>Not quite: it's <span lang={q.kind === 'reading' ? 'ja' : undefined}>{q.answer}</span></>}
              </p>
            </div>
          )}
          <div className="st-row">
            <SpeakButton text={sentence.jp} />
            <SpeakButton text={sentence.jp} rate={0.7} label="Slow" />
            {canSave && <SaveButton sentence={sentence} />}
          </div>
          <Shadow text={sentence.jp} />
          <div className="st-footer">
            <button ref={continueRef} type="button" className="btn ink st-grow" onClick={onNext}>
              {last ? doneLabel : 'Continue'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Reads through `sentences`. Calls markSentencesShown for the ones seen, so
 * they rest for a week, then onDone.
 */
export function ReadingDrill({ sentences, onProgress, onDone, doneLabel = 'Continue' }: {
  sentences: readonly SentenceLike[];
  /** The 0-based index of the sentence on screen. */
  onProgress?: (index: number) => void;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [index, setIndex] = useState(0);
  const seen = useRef(new Set<string>());
  const phase = useAsync(currentPhase, []);
  const sentence = sentences[index];

  useEffect(() => {
    if (sentence) seen.current.add(sentence.id);
    onProgress?.(index);
  }, [index, sentence, onProgress]);

  // Leaving part-way still rests the sentences already shown.
  useEffect(() => () => {
    if (seen.current.size) markSentencesShown([...seen.current]);
  }, []);

  if (!sentence) return null;
  const next = () => {
    if (index + 1 < sentences.length) {
      setIndex(index + 1);
      return;
    }
    markSentencesShown([...seen.current]);
    seen.current.clear();
    onDone();
  };

  return (
    <SentenceStep key={sentence.id} sentence={sentence} last={index + 1 === sentences.length} doneLabel={doneLabel}
      canSave={(phase.data ?? 1) >= SAVE_FROM_PHASE} onNext={next} />
  );
}
