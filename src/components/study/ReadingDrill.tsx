// Read & shadow: one sentence at a time, a quick question about it, then the
// translation, listening, shadowing and (from phase 3) saving. Not graded.

import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { db } from '../../lib/db.ts';
import { useRubyShow } from '../../lib/hooks.ts';
import { parseRuby, type RubySegment } from '../../lib/ruby.ts';
import { currentPhase } from '../../srs/course.ts';
import { markSentencesShown } from '../../srs/planner.ts';
import { SpeakButton } from '../SpeakButton.tsx';
import { Icon } from '../ui.tsx';
import { ChoiceGrid } from './cards/parts.tsx';
import { prepareReading, type ReadingTarget } from './readingQuestion.ts';
import { saveSentence, type SentenceLike } from './sentences.ts';
import { useFocusHeading, useScrollToTop } from './focus.ts';
import { Shadow } from './Shadow.tsx';
import { useAsync } from './useAsync.ts';

/**
 * The target word's pieces: its ruby segments and the okurigana after them;
 * `rest` is the remainder of that plain segment and `next` the first segment
 * after it.
 */
function targetParts(segs: readonly RubySegment[], target: ReadingTarget) {
  const end = target.start + target.count;
  const plainAfter = segs[end]?.reading === undefined ? segs[end] : undefined;
  const chars = plainAfter ? [...plainAfter.text] : [];
  return {
    word: segs.slice(target.start, end),
    tail: chars.slice(0, target.tail).join(''),
    rest: chars.slice(target.tail).join(''),
    next: plainAfter ? end + 1 : end,
  };
}

/**
 * The sentence with ruby per the furigana setting; the target word (with its
 * okurigana) underlined, its reading hidden until answered.
 */
export function SentenceText({ jp, target, revealTarget = false }: { jp: string; target?: ReadingTarget; revealTarget?: boolean }) {
  const show = useRubyShow();
  const segs = parseRuby(jp);
  const render = (seg: RubySegment, i: number, inTarget: boolean): ReactNode => {
    const visible = seg.reading !== undefined
      && (inTarget ? revealTarget : show === 'all' || (typeof show === 'function' && show(seg.text)));
    return <Fragment key={i}>{visible ? <ruby>{seg.text}<rt>{seg.reading}</rt></ruby> : seg.text}</Fragment>;
  };
  if (!target) return <p className="st-sentence" lang="ja">{segs.map((seg, i) => render(seg, i, false))}</p>;

  const { word, tail, rest, next } = targetParts(segs, target);
  return (
    <p className="st-sentence" lang="ja">
      {segs.slice(0, target.start).map((seg, i) => render(seg, i, false))}
      <u className="st-target">{word.map((seg, i) => render(seg, target.start + i, true))}{tail}</u>
      {rest}
      {segs.slice(next).map((seg, i) => render(seg, next + i, false))}
    </p>
  );
}

/** "高 (たか) + い": the underlined word's kanji with their readings, then its kana. */
function TargetBreakdown({ jp, target }: { jp: string; target: ReadingTarget }) {
  const { word, tail } = targetParts(parseRuby(jp), target);
  const parts = [...word.map((seg) => ({ text: seg.text, reading: seg.reading })), ...(tail ? [{ text: tail, reading: undefined }] : [])];
  return (
    <p className="st-fb-breakdown">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> + </span>}
          <span lang="ja" className="st-fb-char">{part.text}</span>
          {part.reading && <> (<span lang="ja">{part.reading}</span>)</>}
        </span>
      ))}
    </p>
  );
}

/** Saving sentences as review cards starts with phase 3, reading for real. */
export const SAVE_FROM_PHASE = 3;

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
          {!q ? 'Read this sentence' : q.kind === 'reading' ? (
            <>
              How do you read the underlined word?
              {/* The underline is only visual: name the word for screen readers. */}
              <span className="visually-hidden"> Underlined: <span lang="ja">{q.written}</span></span>
            </>
          ) : 'What does this mean?'}
        </h2>
        <div className="card st-prompt st-reading-card">
          <SentenceText jp={sentence.jp} target={q?.kind === 'reading' ? q.target : undefined} revealTarget={answered} />
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
            <div className={correct ? 'feedback good st-feedback' : 'feedback bad st-feedback'} role="status">
              <p className="st-fb-title">
                {correct ? 'Correct' : <>Not quite: it's <span lang={q.kind === 'reading' ? 'ja' : undefined}>{q.answer}</span></>}
              </p>
              {q.kind === 'reading' && <TargetBreakdown jp={sentence.jp} target={q.target} />}
            </div>
          )}
          <div className="st-row">
            <SpeakButton text={sentence.jp} rate={0.7} label="Slow" />
            {canSave && <SaveButton sentence={sentence} />}
          </div>
          <Shadow text={sentence.jp} />
          <div className="st-footer">
            <SpeakButton text={sentence.jp} compact label="Listen to the sentence" />
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
