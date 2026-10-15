// Read & listen with study sentences, never graded. Each sentence: read it aloud first; listen, with the sentence's
// pitch drawn per phrase; guess what the underlined word means before the translation shows; then shadow it.
// It can be saved as a cloze card (blanking that word). Each sentence logs its words as encounters and rests a week.

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { clipRef } from '../../../shared/voicevox.ts';
import { db } from '../../lib/db.ts';
import { loadAudioManifest } from '../../lib/data.ts';
import { useRubyShow } from '../../lib/hooks.ts';
import { parseRuby, type RubySegment } from '../../lib/ruby.ts';
import type { ClipAccentPhrase, RubyText, SentenceEntry, WordRef } from '../../lib/types.ts';
import { logEncounters } from '../../srs/encounters.ts';
import { loadKnownWords, markSentencesShown } from '../../srs/readListen.ts';
import { usePlayback } from '../../speech/audio.ts';
import { Icon, Ruby } from '../ui.tsx';
import { AudioButton } from './AudioButton.tsx';
import { ChoiceGrid } from './cards/parts.tsx';
import { tokenOffset } from './cards/prepare.ts';
import { useFocusHeading, useScrollToTop } from './focus.ts';
import { PhrasePitchLine } from './PhrasePitchLine.tsx';
import { glossQuestion } from './readingQuestion.ts';
import { saveSentence, sentencesById } from './sentences.ts';
import { Shadow } from './Shadow.tsx';
import { useAsync } from './useAsync.ts';

export { SAVE_FROM_COURSE_DAY } from './sentences.ts';

export interface PlannedSentence { id: string; target: WordRef }

const toMarkup = (segs: readonly RubySegment[]): RubyText =>
  segs.map((s) => (s.reading === undefined ? s.text : `{${s.text}|${s.reading}}`)).join('');

/**
 * pure: the sentence around one occurrence of `surface` (at plain-text offset `at` when given and right, else the
 * first), every part keeping its readings, the target's own included: this sentence is read aloud first, so a word
 * with a kanji the learner can't read yet needs its reading here (unlike a card, which asks for it). A reading that
 * the word's edge cuts through is dropped. Null when the word is not in the sentence.
 */
export function splitTarget(jp: RubyText, surface: string, at?: number): { before: RubyText; target: RubyText; after: RubyText } | null {
  const segs = parseRuby(jp);
  const plain = segs.map((s) => s.text).join('');
  const start = at !== undefined && plain.startsWith(surface, at) ? at : plain.indexOf(surface);
  if (!surface || start < 0) return null;
  const end = start + surface.length;
  const parts: [RubySegment[], RubySegment[], RubySegment[]] = [[], [], []];
  let pos = 0;
  for (const s of segs) {
    const from = pos;
    pos += s.text.length;
    if (pos <= start) parts[0].push(s);
    else if (from >= end) parts[2].push(s);
    else if (from >= start && pos <= end) parts[1].push(s);
    else {
      if (from < start) parts[0].push({ text: s.text.slice(0, start - from) });
      parts[1].push({ text: s.text.slice(Math.max(start, from) - from, Math.min(end, pos) - from) });
      if (pos > end) parts[2].push({ text: s.text.slice(end - from) });
    }
  }
  return { before: toMarkup(parts[0]), target: toMarkup(parts[1]), after: toMarkup(parts[2]) };
}

/** The sentence with the target word underlined; readings follow the learner's furigana setting throughout. */
export function SentenceText({ jp, surface, at }: { jp: string; surface?: string; at?: number }) {
  const show = useRubyShow();
  const cue = surface ? splitTarget(jp, surface, at) : null;
  if (!cue) return <Ruby className="st-sentence" text={jp} show={show} />;
  return (
    <p className="st-sentence" lang="ja">
      <Ruby text={cue.before} show={show} />
      <u className="st-target"><Ruby text={cue.target} show={show} /></u>
      <Ruby text={cue.after} show={show} />
    </p>
  );
}

function SaveButton({ sentence, target }: { sentence: SentenceEntry; target: WordRef }) {
  const saved = useLiveQuery(() => db.savedSentences.get(sentence.id), [sentence.id]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (saved) {
    return (
      <button type="button" className="btn secondary small st-grow" disabled>
        <Icon name="check" size={16} />Saved as a card
      </button>
    );
  }
  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await saveSentence(sentence, target, 'reading');
    } catch (e) {
      console.error('could not save sentence', e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn secondary small st-grow" onClick={() => void save()} disabled={busy}>
      <Icon name="plus" size={16} />{failed ? 'Try saving again' : 'Save as a card'}
    </button>
  );
}

type Step = 'read' | 'listen' | 'gloss' | 'shadow';

function SentenceStep({ sentence, target, last, doneLabel, canSave, onNext }: {
  sentence: SentenceEntry;
  target: WordRef;
  last: boolean;
  doneLabel: string;
  canSave: boolean;
  onNext: () => void;
}) {
  const surface = sentence.tokens.find((t) => t.ref === target)?.s;
  const gloss = useAsync(async () => glossQuestion(target, surface ?? '', await loadKnownWords()), [sentence.id, target]);
  const pitch = useAsync(async (): Promise<ClipAccentPhrase[] | undefined> => {
    const manifest = await loadAudioManifest();
    const id = manifest.byRef[clipRef.sentence(sentence.id)];
    return id ? manifest.clips[id]?.accentPhrases : undefined;
  }, [sentence.id]);
  const { play } = usePlayback();
  const [step, setStep] = useState<Step>('read');
  const [picked, setPicked] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useScrollToTop(sentence.id);
  useFocusHeading(root, step);
  const source = { ref: clipRef.sentence(sentence.id) };
  const listen = () => {
    setStep((s) => (s === 'read' ? 'listen' : s));
    void play(source, { fallbackText: sentence.jp });
  };
  const q = gloss.data;
  const pick = (option: string) => {
    if (picked !== null) return;
    setPicked(option);
    setStep('shadow');
  };

  return (
    <div className="st-reading" ref={root}>
      <section className="st-question">
        <h2 className="st-ask">
          {step === 'read' ? 'Read it aloud first' : step === 'listen' ? 'Now listen' : step === 'gloss' && q ? (
            <>What does <span lang="ja">{q.written}</span> mean here?</>
          ) : 'Say it with the voice'}
        </h2>
        <div className="card st-prompt st-reading-card">
          <SentenceText jp={sentence.jp} surface={surface} at={tokenOffset(sentence.tokens, target)} />
          {step !== 'read' && pitch.data && <PhrasePitchLine phrases={pitch.data} text={sentence.jp} />}
          {(step === 'shadow' || (step === 'gloss' && !q)) && <p className="st-translation">{sentence.en}</p>}
        </div>
      </section>

      {step === 'gloss' && q && (
        <ChoiceGrid options={q.options} answer={q.answer} picked={picked} onPick={pick} />
      )}
      {step === 'shadow' && q && picked !== null && (
        <div className={picked === q.answer ? 'feedback good st-feedback' : 'feedback bad st-feedback'} role="status">
          <p className="st-fb-title">{picked === q.answer ? 'Yes' : <>It means "{q.answer}"</>}</p>
        </div>
      )}
      {step === 'shadow' && (
        <>
          <Shadow text={sentence.jp} source={source} />
          {canSave && <div className="st-row"><SaveButton sentence={sentence} target={target} /></div>}
        </>
      )}

      <div className="st-footer">
        {step === 'read' && <button type="button" className="btn ink st-grow" onClick={listen}>Listen</button>}
        {step === 'listen' && (
          <>
            <AudioButton compact source={source} fallbackText={sentence.jp} label="Listen again" />
            {/* The guess comes first: wait for its options rather than skipping it. */}
            <button type="button" className="btn ink st-grow" disabled={gloss.loading} onClick={() => setStep(q ? 'gloss' : 'shadow')}>
              {q || gloss.loading ? 'What does it mean?' : 'Continue'}
            </button>
          </>
        )}
        {step === 'gloss' && !q && <button type="button" className="btn ink st-grow" onClick={() => setStep('shadow')}>Continue</button>}
        {step === 'shadow' && (
          <>
            <AudioButton compact source={source} fallbackText={sentence.jp} label="Listen to the sentence" />
            <button type="button" className="btn ink st-grow" onClick={onNext}>{last ? doneLabel : 'Next sentence'}</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Reads through the planned sentences. After each one its words are logged as encounters and it rests for a week
 * (markSentencesShown); then onDone.
 */
export function ReadingDrill({ sentences, onProgress, onDone, doneLabel = 'Continue', canSave = true }: {
  sentences: readonly PlannedSentence[];
  /** The 0-based index of the sentence on screen. */
  onProgress?: (index: number) => void;
  onDone: () => void;
  doneLabel?: string;
  /** Saving as a cloze card (from course day 1). */
  canSave?: boolean;
}) {
  const ids = sentences.map((s) => s.id).join(',');
  const loaded = useAsync(() => sentencesById(sentences.map((s) => s.id)), [ids]);
  const [index, setIndex] = useState(0);
  const finished = useRef(false);
  const list = (loaded.data ?? []).flatMap((entry) => {
    const planned = sentences.find((s) => s.id === entry.id);
    return planned ? [{ entry, target: planned.target }] : [];
  });
  const current = list[index];

  useEffect(() => onProgress?.(index), [index, onProgress]);
  // Nothing to read (the sentences are not on this phone): move on.
  useEffect(() => {
    if (!loaded.loading && !list.length && !finished.current) {
      finished.current = true;
      onDone();
    }
  });

  if (loaded.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the sentences" />;
  if (!current) return null;
  const next = () => {
    const { entry } = current;
    void logEncounters(entry.refs, 'sentence').catch((e: unknown) => console.warn('could not log encounters', e));
    void markSentencesShown([entry.id]).catch((e: unknown) => console.warn('could not rest the sentence', e));
    if (index + 1 < list.length) {
      setIndex(index + 1);
      return;
    }
    if (finished.current) return;
    finished.current = true;
    onDone();
  };
  return (
    <SentenceStep key={current.entry.id} sentence={current.entry} target={current.target} last={index + 1 === list.length}
      doneLabel={doneLabel} canSave={canSave} onNext={next} />
  );
}
