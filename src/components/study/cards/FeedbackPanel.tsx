// After a graded answer. A miss (or Hard) teaches: the full answer with the stroke animation once, the reading with
// audio and pitch line, the word inside a known sentence, the parts with their names and the memory hook. A fast
// correct answer only confirms it in one line and moves on by itself; a slower one waits for Continue. A surprise
// miss (a word that was easy last time) also lists the parts, two related words and a field for your own hook.
// The leak guard keeps out anything another card due today still asks: a word whose kanji is still to be written from
// memory today is shown in kana, and its parts panel leaves that kanji out.
// "Back …" says when the card is really next shown: a missed card comes once more in this block, and nothing reviewed
// today comes back before the next study day, whatever its learning step says.

import Dexie from 'dexie';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import { clipRef } from '../../../../shared/voicevox.ts';
import { dayKey, db } from '../../../lib/db.ts';
import { loadKanaExamples, loadKanji, loadMnemonics, loadRadicals, loadSentences, loadWords } from '../../../lib/data.ts';
import { useCardRubyShow, useSettings } from '../../../lib/hooks.ts';
import { isKanji, parseRuby } from '../../../lib/ruby.ts';
import type { KanjiEntry, ReviewLogRecord, RubyText, SentenceEntry } from '../../../lib/types.ts';
import { needsCalibrationTip } from '../../../srs/answers.ts';
import type { LeakMask } from '../../../srs/planner.ts';
import { exampleSentenceFor, loadKnownWords } from '../../../srs/readListen.ts';
import { play, type AudioSource } from '../../../speech/audio.ts';
import { StrokeAnimation } from '../../../writing/StrokeOrder.tsx';
import { useStrokes } from '../../../writing/useStrokes.ts';
import { Glyph } from '../../Glyph.tsx';
import { Ruby } from '../../ui.tsx';
import { AudioButton } from '../AudioButton.tsx';
import { untilText } from '../format.ts';
import { MemoryHook } from '../learn/KanjiLesson.tsx';
import { MixedText } from '../MixedText.tsx';
import { PitchLine } from '../PitchLine.tsx';
import { useAsync } from '../useAsync.ts';
import { KanaText } from './KanaText.tsx';
import { shownWord } from './prepare.ts';
import type { PreparedCard } from './types.ts';

export const FAST_AUTO_ADVANCE_MS = 1200;
/** Related words listed after a surprise miss. */
const RELATED_WORDS = 2;
/** Write logs looked at for the calibration tip. */
const CALIBRATION_WINDOW = 200;

/**
 * The item the card belongs to, the kanji its answer is written with (related words share them), and the kanji the
 * card itself has already shown or asks (the leak guard lets those through: they are on screen anyway). A produce or
 * listen card never showed its word's kanji: a kanji still to be written today stays out of its feedback.
 */
function ownOf(p: PreparedCard): { itemId: string; kanji: string[]; shown: string[] } {
  const itemId = p.card.itemId;
  switch (p.view) {
    case 'kanji-write':
    case 'kanji-meaning': {
      const kanji = [p.kanji.char, ...(p.view === 'kanji-write' && p.anchor ? p.anchor.kanji : [])];
      return { itemId, kanji, shown: kanji };
    }
    case 'word-read': return { itemId, kanji: p.word.kanji, shown: p.word.kanji };
    case 'produce':
    case 'listen': return { itemId, kanji: p.word.kanji, shown: [] };
    case 'cloze': {
      const kanji = [...p.sentence.jp].filter(isKanji);
      return { itemId, kanji, shown: kanji };
    }
    default: return { itemId, kanji: [], shown: [] };
  }
}

/**
 * "Back …": once more in this block after a re-ask; else the next study day for anything due again today (the
 * warm-up never brings back a card reviewed today, §1.1), else when it is due.
 */
export function backText(due: Date | undefined, reasked: boolean, now: Date = new Date()): string {
  if (reasked) return 'Back once more in a few cards';
  if (!due) return ' ';
  return dayKey(due) <= dayKey(now) ? 'Back tomorrow' : `Back ${untilText(due, now)}`;
}

interface AnswerView {
  /** The headline answer: Japanese (ruby markup) or plain text. */
  jp?: RubyText;
  text?: string;
  en?: string;
  audio?: { source: AudioSource; fallbackText?: RubyText };
  /** A character whose strokes are animated after a miss. */
  glyph?: string;
  /** The word ref for a pitch line and an example sentence. */
  wordRef?: string;
  /** Moras to label the pitch line with. */
  pitchKana?: string;
}

const ruby = (written: string, kana: string): RubyText => (written !== kana ? `{${written}|${kana}}` : kana);

/** What the answer is, per card view. */
export function answerOf(p: PreparedCard, mask?: LeakMask): AnswerView {
  switch (p.view) {
    case 'kana-read':
      return p.mode === 'romaji'
        ? { jp: p.kana.char, text: p.kana.romaji, audio: { source: { ref: clipRef.kana(p.kana.char) }, fallbackText: p.kana.char } }
        : { jp: p.word?.kana ?? p.kana.char, en: p.word?.en, audio: { source: { ref: p.word ? clipRef.kanaEx(p.kana.char) : clipRef.kana(p.kana.char) }, fallbackText: p.word?.kana ?? p.kana.char } };
    case 'kana-write':
      return { jp: p.kana.char, glyph: p.kana.char, ...(p.word ? { en: `${p.word.kana} · ${p.word.en}` } : {}), audio: { source: { ref: clipRef.kana(p.kana.char) }, fallbackText: p.kana.char } };
    case 'kana-rule':
      return { jp: p.word.kana, en: p.word.en, audio: { source: { ref: clipRef.kanaRule(p.rule.id, p.wordIndex) }, fallbackText: p.word.kana } };
    case 'kanji-write': {
      // The anchor is another item: its reading or meaning stays hidden while its own card is due today.
      const anchorMeaningHidden = p.anchor && mask?.meanings.has(p.anchor.ref);
      const anchorReadingHidden = p.anchor && mask?.readings.has(p.anchor.ref);
      return {
        jp: p.anchor ? (anchorReadingHidden ? p.anchor.written : ruby(p.anchor.written, p.anchor.kana)) : p.kanji.char,
        text: p.kanji.meanings[0],
        ...(p.anchor && !anchorMeaningHidden ? { en: p.anchor.en } : {}),
        glyph: p.kanji.char,
        audio: p.anchor ? { source: { ref: p.anchor.ref }, fallbackText: p.anchor.kana } : { source: { text: p.reading } },
        ...(p.anchor ? { wordRef: p.anchor.ref } : {}),
      };
    }
    case 'kanji-meaning':
      return { jp: p.kanji.char, text: p.kanji.meanings.join(', '), glyph: p.kanji.char };
    case 'word-read':
      return { jp: p.display, en: p.word.en, audio: { source: { ref: p.word.ref }, fallbackText: p.display }, wordRef: p.word.ref, pitchKana: p.word.kana };
    case 'produce':
    case 'listen': {
      // The question never showed the word's kanji: one still to be written from memory today stays back (kana only).
      const jp = shownWord(p.display, p.word, mask);
      return { jp, en: p.word.en, audio: { source: { ref: p.word.ref }, fallbackText: jp }, wordRef: p.word.ref, pitchKana: p.word.kana };
    }
    case 'grammar-comprehend':
      return { jp: p.example.jp, en: p.example.en, audio: { source: { ref: clipRef.grammarExample(p.point.id, p.exampleIndex) }, fallbackText: p.example.jp } };
    case 'grammar-build':
      return { jp: p.item.jp, en: p.item.en, audio: { source: { ref: clipRef.grammarBuild(p.point.id, p.itemIndex) }, fallbackText: p.item.jp } };
    case 'cloze':
      return {
        jp: p.sentence.jp,
        // わたし (わたし) says nothing twice: the reading only follows a surface written differently.
        text: p.sentence.blank.surface === p.sentence.blank.reading ? p.sentence.blank.surface : `${p.sentence.blank.surface} (${p.sentence.blank.reading})`,
        en: p.sentence.en,
        audio: { source: { ref: clipRef.sentence(p.sentence.id) }, fallbackText: p.sentence.jp },
      };
  }
}

interface Part { char: string; name?: string }
interface Related { id: string; written: string; kana?: string; en?: string }

interface MissExtras {
  hook?: string;
  parts: Part[];
  sentence?: SentenceEntry;
  related: Related[];
  calibrationTip: boolean;
}

/**
 * The kanji the parts panel explains for this card: the kanji itself, or each kanji of the word as the feedback shows
 * it. A word still in kana (a core word not yet spelled, or a kanji held back by the leak guard) has no parts, and only
 * kanji the learner has been introduced to are listed (`met`).
 */
function partsFor(p: PreparedCard, kanji: Record<string, KanjiEntry>, names: ReadonlyMap<string, string>, mask: LeakMask, met: ReadonlySet<string>): Part[] {
  if (p.view === 'kanji-write' || p.view === 'kanji-meaning') {
    const k = p.kanji;
    return [
      ...k.components.map((c) => ({ char: c, name: kanji[c]?.meanings[0] })),
      ...k.parts.map((c) => ({ char: c, name: names.get(c) })),
    ];
  }
  if (p.view === 'word-read' || p.view === 'produce' || p.view === 'listen') {
    const shown = new Set(parseRuby(answerOf(p, mask).jp ?? '').flatMap((seg) => [...seg.text]));
    return [...new Set(p.word.kanji)]
      .filter((c) => shown.has(c) && met.has(c))
      .map((c) => ({ char: c, name: mask.meanings.has(`kanji:${c}`) ? undefined : kanji[c]?.meanings[0] }));
  }
  return [];
}

async function loadExtras(p: PreparedCard, mask: LeakMask, surprise: boolean): Promise<MissExtras> {
  const own = ownOf(p);
  const [kanji, radicals, mnemonics] = await Promise.all([loadKanji(), loadRadicals(), loadMnemonics()]);
  const names = new Map(radicals.map((r) => [r.char, r.name]));
  const ownKanji = new Set(own.kanji);
  const shownKanji = new Set(own.shown);
  const leaks = (chars: Iterable<string>) => [...chars].some((c) => isKanji(c) && !shownKanji.has(c) && mask.kanji.has(c));

  let hook = p.customMnemonic;
  if (!hook && (p.view === 'kana-write' || p.view === 'kana-read')) {
    hook = (await loadKanaExamples().catch(() => ({} as Record<string, { hook?: string }>)))[p.kana.char]?.hook;
  }
  if (!hook && (p.view === 'kanji-write' || p.view === 'kanji-meaning')) hook = mnemonics[p.kanji.char]?.meaning;

  const answer = answerOf(p, mask);
  let sentence: SentenceEntry | undefined;
  let related: Related[] = [];
  if (answer.wordRef) {
    const known = await loadKnownWords();
    const candidate = exampleSentenceFor(answer.wordRef, await loadSentences(), known);
    const othersLeak = candidate && candidate.refs.some((r) => r !== answer.wordRef && (mask.readings.has(r) || mask.meanings.has(r)));
    if (candidate && !othersLeak && !leaks(candidate.jp)) sentence = candidate;
    if (surprise) {
      const words = await loadWords();
      related = words
        .filter((w) => `word:${w.id}` !== answer.wordRef && `word:${w.id}` !== own.itemId && w.kanji.some((c) => ownKanji.has(c)) && !leaks(w.written))
        .sort((a, b) => Number(known.isKnown(`word:${b.id}`)) - Number(known.isKnown(`word:${a.id}`)) || a.freqRank - b.freqRank)
        .slice(0, RELATED_WORDS)
        .map((w) => {
          const ref = `word:${w.id}`;
          return {
            id: w.id,
            written: w.written,
            ...(mask.readings.has(ref) ? {} : { kana: w.kana }),
            ...(mask.meanings.has(ref) ? {} : { en: w.meanings[0] }),
          };
        });
    }
  }

  let calibrationTip = false;
  if (p.view === 'kanji-write' || p.view === 'kana-write') {
    const logs: ReviewLogRecord[] = await db.reviewLogs
      .where('[type+reviewedAt]').between(['write', Dexie.minKey], ['write', Dexie.maxKey])
      .reverse().limit(CALIBRATION_WINDOW).toArray();
    calibrationTip = needsCalibrationTip(logs);
  }
  const wordKanji = p.view === 'word-read' || p.view === 'produce' || p.view === 'listen' ? [...new Set(p.word.kanji)] : [];
  const metRows = wordKanji.length ? await db.items.bulkGet(wordKanji.map((c) => `kanji:${c}`)) : [];
  const met = new Set(metRows.flatMap((row) => (row ? [row.key] : [])));
  return { ...(hook ? { hook } : {}), parts: partsFor(p, kanji, names, mask, met), ...(sentence ? { sentence } : {}), related, calibrationTip };
}

function AnswerLine({ answer }: { answer: AnswerView }) {
  return (
    <p className="st-fb-answer">
      {answer.jp && <KanaText text={answer.jp} show="all" className="st-fb-jp" />}
      {answer.text && <span className="st-fb-text">{answer.text}</span>}
      {answer.en && <span className="st-fb-en"><MixedText text={answer.en} /></span>}
    </p>
  );
}

function StrokesOnce({ char }: { char: string }) {
  const { strokes } = useStrokes(char);
  if (!strokes?.length) return <div className="st-paper-answer"><Glyph char={char} size={96} /></div>;
  return <StrokeAnimation strokes={strokes} label={`Stroke order of ${char}`} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="st-fb-section">
      <h3 className="label">{title}</h3>
      {children}
    </section>
  );
}

export function FeedbackPanel({ prepared, grade, durationMs, medianMs, surprise, due, reasked = false, hold = false, mask, onContinue }: {
  prepared: PreparedCard;
  grade: Grade;
  durationMs: number;
  /** Per-user median for the card's timing key, ms. */
  medianMs: number;
  surprise: boolean;
  due?: Date;
  /** A missed card comes back once more later in this block. */
  reasked?: boolean;
  /** The card still shows something to read (stroke-order coaching): no automatic Continue. */
  hold?: boolean;
  mask: LeakMask;
  onContinue: () => void;
}) {
  const { audio } = useSettings();
  const show = useCardRubyShow();
  const continueRef = useRef<HTMLButtonElement>(null);
  const continued = useRef(false);
  const missed = grade === Rating.Again || grade === Rating.Hard || surprise;
  const fast = !missed && !hold && grade === Rating.Good && durationMs < medianMs;
  const answer = answerOf(prepared, mask);
  const extras = useAsync(() => (missed ? loadExtras(prepared, mask, surprise) : Promise.resolve(null)), [prepared.card.id, missed, surprise]);
  const own = ownOf(prepared);
  const [hookSaved, setHookSaved] = useState<string>();

  const next = () => {
    if (continued.current) return;
    continued.current = true;
    onContinue();
  };

  useEffect(() => continueRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (audio && answer.audio) void play(answer.audio.source, answer.audio.fallbackText ? { fallbackText: answer.audio.fallbackText } : {});
    // Once per answer.
  }, []);
  useEffect(() => {
    if (!fast) return;
    const t = setTimeout(next, FAST_AUTO_ADVANCE_MS);
    return () => clearTimeout(t);
  }, [fast]);

  const tone = grade === Rating.Again ? 'bad' : 'good';
  const headline = grade === Rating.Again ? (surprise ? 'That one slipped' : 'Not quite') : grade === Rating.Hard ? 'Got it, with some effort' : 'Correct';
  const x = extras.data;
  const accent = 'accent' in prepared ? prepared.accent : undefined;

  if (fast) {
    return (
      <div className={`feedback ${tone} st-feedback st-fb-fast`} role="status" onClick={next}>
        <p className="st-fb-title">{headline}</p>
        <AnswerLine answer={answer} />
      </div>
    );
  }

  return (
    <>
      <div className={`feedback ${tone} st-feedback`} role="status">
        <p className="st-fb-title">{headline}</p>
        <AnswerLine answer={answer} />
        {missed && accent && <PitchLine accent={accent} kana={answer.pitchKana} size="sm" />}
        <p className="st-fb-when">{backText(due, reasked)}</p>
      </div>

      {missed && (
        <div className="st-fb-teach">
          {answer.glyph && <StrokesOnce char={answer.glyph} />}
          {x?.sentence && (
            <Section title="In a sentence">
              <p className="st-fb-sentence"><Ruby text={x.sentence.jp} show={show} /></p>
              <p className="st-translation">{x.sentence.en}</p>
            </Section>
          )}
          {x && x.parts.length > 0 && (
            <Section title="Parts">
              <ul className="st-fb-parts">
                {x.parts.map((part) => (
                  <li key={part.char}><Glyph char={part.char} size={24} />{part.name && <span>{part.name}</span>}</li>
                ))}
              </ul>
            </Section>
          )}
          {x?.hook && <div className="st-hook"><h3 className="label">Memory hook</h3><p><MixedText text={x.hook} /></p></div>}
          {surprise && x && x.related.length > 0 && (
            <Section title={`Also with ${own.kanji.slice(0, 1).join('')}`}>
              <ul className="st-fb-related">
                {x.related.map((w) => (
                  <li key={w.id}>
                    <span lang="ja" className="st-word-written">{w.written}</span>
                    {w.kana && <span lang="ja" className="st-word-kana">{w.kana}</span>}
                    {w.en && <span className="st-word-en">{w.en}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {surprise && (
            <MemoryHook text={hookSaved}
              onChange={(text) => {
                setHookSaved(text || undefined);
                void db.items.update(own.itemId, { customMnemonic: text || undefined }).catch((e: unknown) => console.error('could not save the hook', e));
              }} />
          )}
          {x?.calibrationTip && (
            <p className="st-note st-fb-tip">Your "I wrote it right" taps are above 10 % — try writing a little slower.</p>
          )}
        </div>
      )}

      <div className="st-footer">
        {answer.audio && <AudioButton compact source={answer.audio.source} fallbackText={answer.audio.fallbackText} label="Listen" />}
        <button ref={continueRef} type="button" className="btn ink st-grow" onClick={next}>Continue</button>
      </div>
    </>
  );
}
