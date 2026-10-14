// Runs a block of review cards: shows each card, grades the answer with FSRS,
// shows feedback, and repeats missed cards once at the end (ungraded).

import { useEffect, useRef, useState } from 'react';
import { Rating } from 'ts-fsrs';
import { db } from '../../lib/db.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { FeedbackPanel } from './cards/FeedbackPanel.tsx';
import { prepareCard } from './cards/prepare.ts';
import { ReviewCard } from './cards/ReviewCard.tsx';
import type { CardAnswer, PreparedCard } from './cards/types.ts';
import { useFocusHeading, useScrollToTop } from './focus.ts';
import type { StudyTimer } from './time.ts';

interface QueueItem {
  cardId: string;
  /** A repeat of a missed card, for practice only. */
  practice: boolean;
}

export interface BlockProgress {
  /** Main cards answered (or skipped) so far. */
  done: number;
  /** 1-based position in the main cards, or in the practice repeats. */
  position: number;
  total: number;
  practice: boolean;
}

/** A card that no longer exists or is suspended is skipped. `block` is every card of the block. */
async function load(cardId: string, block: readonly string[]): Promise<PreparedCard | null> {
  const card = await db.cards.get(cardId);
  return card && !card.suspended ? prepareCard(card, Math.random, { block }) : null;
}

export function ReviewBlock({ cardIds, timer, onProgress, onAnswered, onDone }: {
  cardIds: readonly string[];
  timer: StudyTimer;
  onProgress?: (progress: BlockProgress) => void;
  /** Each graded (non-practice) answer. */
  onAnswered?: (correct: boolean) => void;
  onDone: () => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>(() => cardIds.map((cardId) => ({ cardId, practice: false })));
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState<{ index: number; prepared: PreparedCard | null; failed?: boolean } | null>(null);
  const [answer, setAnswer] = useState<{ value: CardAnswer; due?: Date } | null>(null);
  const loads = useRef(new Map<number, Promise<PreparedCard | null>>());
  const pending = useRef<Promise<unknown>[]>([]);
  const startedAt = useRef(0);
  const finished = useRef(false);
  const block = useRef<HTMLDivElement>(null);

  const mainCount = cardIds.length;
  const item = queue[index];
  const current = shown?.index === index ? shown : null;
  useScrollToTop(index);
  useFocusHeading(block, current);

  const loadAt = (i: number) => {
    let p = loads.current.get(i);
    if (!p && queue[i]) {
      p = load(queue[i].cardId, cardIds);
      loads.current.set(i, p);
    }
    return p;
  };

  // Load the card on screen, and the one after it so it appears without a wait.
  useEffect(() => {
    let live = true;
    loadAt(index)?.then(
      (prepared) => live && setShown({ index, prepared }),
      (e: unknown) => {
        console.error('could not load card', e);
        if (live) setShown({ index, prepared: null, failed: true });
      },
    );
    loadAt(index + 1)?.catch(() => {});
    return () => {
      live = false;
    };
    // loadAt reads the latest queue; it only matters when the index or queue changes.
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
    const practice = item.practice;
    onProgress?.({
      done: Math.min(mainCount, index + (answered ? 1 : 0)),
      position: practice ? index - mainCount + 1 : index + 1,
      total: practice ? queue.length - mainCount : mainCount,
      practice,
    });
  }, [item, index, answered, queue.length, mainCount, onProgress]);

  const onAnswer = (value: CardAnswer) => {
    if (!item || answered) return;
    const durationMs = timer.elapsed() - startedAt.current;
    let next = queue;
    if (!item.practice) {
      onAnswered?.(value.correct);
      if (value.grade === Rating.Again) next = [...queue, { cardId: item.cardId, practice: true }];
      timer.creditAnswer(durationMs);
      const graded = gradeCard(item.cardId, value.grade, { durationMs, mode: value.mode }).then(
        (card) => setAnswer((a) => (a?.value === value ? { ...a, due: card.due } : a)),
        (e: unknown) => console.error('could not save the grade', e),
      );
      pending.current.push(graded);
    }
    setQueue(next);
    if (value.feedback) setAnswer({ value });
    else advance(next);
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
      {item.practice && <p className="chip shu st-practice-chip">Once more, for practice</p>}
      <ReviewCard key={index} prepared={current.prepared} practice={item.practice} onAnswer={onAnswer} />
      {answer?.value.feedback && (
        <FeedbackPanel key={`feedback-${index}`} correct={answer.value.correct} content={answer.value.feedback}
          due={answer.due} practice={item.practice} onContinue={() => advance(queue)} />
      )}
    </div>
  );
}
