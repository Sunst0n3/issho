// Runs a block of graded cards (the warm-up or the first check): shows each card, grades the answer once with FSRS,
// and shows feedback. A graded Again comes back once, after at least five other cards, and that re-ask is graded too.

import { useEffect, useRef, useState } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import { db } from '../../lib/db.ts';
import { useSettings } from '../../lib/hooks.ts';
import type { ReviewLogRecord } from '../../lib/types.ts';
import { isSurpriseMiss } from '../../srs/answers.ts';
import { noteReviewProgress } from '../../srs/habits.ts';
import { leakMask, type LeakMask } from '../../srs/planner.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { DEFAULT_SECONDS, secondsPerKey, timingKeyOf, type TimingKey } from '../../srs/timing.ts';
import { pushStats } from '../../sync/stats.ts';
import { FeedbackPanel } from './cards/FeedbackPanel.tsx';
import { loadPrepareContext, prepareCard, type PrepareContext } from './cards/prepare.ts';
import { ReviewCard } from './cards/ReviewCard.tsx';
import type { CardAnswer, PreparedCard } from './cards/types.ts';
import { useFocusHeading, useScrollToTop } from './focus.ts';
import type { StudyTimer } from './time.ts';

/** A missed card comes back after at least this many other cards. */
export const REASK_GAP = 5;

const EMPTY_MASK: LeakMask = { readings: new Set(), meanings: new Set(), kanji: new Set() };

interface QueueItem {
  cardId: string;
  /** The graded second ask of a card missed earlier in this block. */
  reask: boolean;
}

export interface BlockProgress {
  /** Cards of the block answered (or skipped) so far, re-asks not counted. */
  done: number;
  /** 1-based position in the whole queue, re-asks included. */
  position: number;
  /** Cards in the queue now, re-asks included. */
  total: number;
  reask: boolean;
}

interface Shown {
  index: number;
  prepared: PreparedCard | null;
  failed?: boolean;
  lastLog?: Pick<ReviewLogRecord, 'grade' | 'durationMs'>;
  medianMs: number;
}

interface Answered {
  value: CardAnswer;
  durationMs: number;
  surprise: boolean;
  due?: Date;
}

/** pure: where a missed card goes back in the queue: after REASK_GAP other cards, or at the end when fewer remain. */
export function reaskPosition(index: number, length: number): number {
  return Math.min(index + 1 + REASK_GAP, length);
}

export function ReviewBlock({ cardIds, timer, context, hideCounts = false, onProgress, onAnswered, onRetrieved, mayRetrieve, makeup = false,
  paperAllowed = true, onDone }: {
  cardIds: readonly string[];
  timer: StudyTimer;
  context: 'review' | 'first-check';
  /** Never show counts (catch-up). */
  hideCounts?: boolean;
  onProgress?: (p: BlockProgress) => void;
  onAnswered?: (correct: boolean) => void;
  /** First check: each retrieval of a new card (for the per-card day-0 cap). */
  onRetrieved?: (cardId: string) => void;
  /** First check: whether one more retrieval of the card stays within the day-0 cap (a re-ask is skipped otherwise). */
  mayRetrieve?: (cardId: string) => boolean;
  /** Make-up session: grades carry `makeup: true`. */
  makeup?: boolean;
  /** Anywhere sitting: hide "Write on paper". */
  paperAllowed?: boolean;
  onDone: () => void;
}) {
  const { handsBusy } = useSettings();
  const [queue, setQueue] = useState<QueueItem[]>(() => cardIds.map((cardId) => ({ cardId, reask: false })));
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [answer, setAnswer] = useState<Answered | null>(null);
  const [mask, setMask] = useState<LeakMask>(EMPTY_MASK);
  const ctx = useRef<Promise<PrepareContext> | null>(null);
  const seconds = useRef<Promise<Record<TimingKey, number>> | null>(null);
  const loads = useRef(new Map<number, Promise<Omit<Shown, 'index'>>>());
  const graded = useRef(new Set<number>());
  const pending = useRef<Promise<unknown>[]>([]);
  const startedAt = useRef(0);
  const finished = useRef(false);
  const block = useRef<HTMLDivElement>(null);

  const item = queue[index];
  const current = shown?.index === index ? shown : null;
  useScrollToTop(index);
  useFocusHeading(block, current);

  const refreshMask = () => {
    leakMask().then(setMask, (e: unknown) => console.warn('could not load the leak mask', e));
  };
  useEffect(refreshMask, []);

  const load = (i: number, q: readonly QueueItem[]) => {
    let p = loads.current.get(i);
    const entry = q[i];
    if (p || !entry) return p;
    ctx.current ??= loadPrepareContext();
    seconds.current ??= secondsPerKey().catch(() => DEFAULT_SECONDS);
    p = (async () => {
      const card = await db.cards.get(entry.cardId);
      // Gone, retired, or (first check) already checked in another sitting: skip it.
      if (!card || card.suspended || (context === 'first-check' && !entry.reask && card.reps > 0)) {
        return { prepared: null, medianMs: 0 };
      }
      const [c, sec, logs] = await Promise.all([
        ctx.current!,
        seconds.current!,
        db.reviewLogs.where('cardId').equals(card.id).sortBy('reviewedAt'),
      ]);
      const prepared = await prepareCard(card, c);
      const last = logs.at(-1);
      return { prepared, medianMs: sec[timingKeyOf(card.kind, card.type)] * 1000, ...(last ? { lastLog: last } : {}) };
    })();
    loads.current.set(i, p);
    return p;
  };

  // Load the card on screen, and the one after it so it appears without a wait.
  useEffect(() => {
    let live = true;
    load(index, queue)?.then(
      (loaded) => live && setShown({ index, ...loaded }),
      (e: unknown) => {
        console.error('could not load card', e);
        if (live) setShown({ index, prepared: null, failed: true, medianMs: 0 });
      },
    );
    load(index + 1, queue)?.catch(() => {});
    return () => {
      live = false;
    };
    // `load` reads the latest queue; it only matters when the index or queue changes.
  }, [index, queue]);

  const advance = (q: readonly QueueItem[]) => {
    setAnswer(null);
    if (index + 1 < q.length) {
      setIndex(index + 1);
      return;
    }
    if (finished.current) return;
    finished.current = true;
    // Let the last grade land before the block reports it is done.
    void Promise.allSettled(pending.current).then(onDone);
  };

  // A card whose content is missing is skipped without a grade; so is an empty block.
  useEffect(() => {
    if (!queue.length && !finished.current) {
      finished.current = true;
      onDone();
    } else if (current && !current.prepared && !current.failed) {
      advance(queue);
    }
  });

  useEffect(() => {
    if (current?.prepared) startedAt.current = timer.elapsed();
  }, [current, timer]);

  const answered = answer !== null;
  useEffect(() => {
    if (!item) return;
    const before = queue.slice(0, index + (answered ? 1 : 0)).filter((q) => !q.reask).length;
    onProgress?.({ done: before, position: index + 1, total: queue.length, reask: item.reask });
  }, [item, index, answered, queue, onProgress]);

  const onAnswer = (value: CardAnswer) => {
    if (!item || answered || graded.current.has(index) || !current?.prepared) return;
    graded.current.add(index);
    const durationMs = Math.max(0, timer.elapsed() - startedAt.current);
    const grade: Grade = value.grade;
    const surprise = !item.reask && isSurpriseMiss(current.lastLog, current.medianMs, grade);
    if (context === 'first-check') onRetrieved?.(item.cardId);
    onAnswered?.(grade !== Rating.Again);
    timer.creditAnswer(durationMs);

    const gradeContext = context === 'first-check' ? 'first-check' : item.reask ? 're-ask' : 'review';
    const saved = gradeCard(item.cardId, grade, {
      durationMs,
      mode: value.mode,
      context: gradeContext,
      ...(value.parts ? { parts: value.parts } : {}),
      ...(value.input ? { input: value.input } : {}),
      ...(value.override ? { override: true } : {}),
      ...(surprise ? { surprise: true } : {}),
      ...(makeup ? { makeup: true } : {}),
    }).then(
      (card) => {
        setAnswer((a) => (a?.value === value ? { ...a, due: card.due } : a));
        refreshMask();
        void noteReviewProgress().catch((e: unknown) => console.warn('could not note review progress', e));
        void pushStats();
      },
      (e: unknown) => console.error('could not save the grade', e),
    );
    pending.current.push(saved);

    let next = queue;
    const reaskAllowed = context !== 'first-check' || (mayRetrieve?.(item.cardId) ?? true);
    if (grade === Rating.Again && !item.reask && reaskAllowed) {
      const at = reaskPosition(index, queue.length);
      next = [...queue];
      next.splice(at, 0, { cardId: item.cardId, reask: true });
      // Positions from the insertion on now hold other cards: forget what was loaded for them.
      for (const i of [...loads.current.keys()]) if (i >= at) loads.current.delete(i);
      setQueue(next);
    }
    // A revealed card answered Good already shows its answer: no panel to read again.
    if (value.revealed && grade === Rating.Good) advance(next);
    else setAnswer({ value, durationMs, surprise });
  };

  if (!item) return null;
  if (!current || (!current.prepared && !current.failed)) {
    return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the next card" />;
  }
  if (!current.prepared) {
    return (
      <div className="card st-error" role="alert">
        <p>This card didn't load. You can skip it for now; it will come back.</p>
        <button type="button" className="btn secondary" onClick={() => advance(queue)}>Skip it</button>
      </div>
    );
  }

  return (
    <div className="st-block" ref={block}>
      {item.reask && <p className="chip shu st-practice-chip">{hideCounts ? 'Once more' : 'Once more, from earlier'}</p>}
      <ReviewCard key={index} prepared={current.prepared} onAnswer={onAnswer} handsBusy={handsBusy} paperAllowed={paperAllowed} />
      {answer && (
        <FeedbackPanel key={`feedback-${index}`} prepared={current.prepared} grade={answer.value.grade} durationMs={answer.durationMs}
          medianMs={current.medianMs} surprise={answer.surprise} due={answer.due} mask={mask} onContinue={() => advance(queue)} />
      )}
    </div>
  );
}
