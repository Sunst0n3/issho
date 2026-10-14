// FSRS scheduling (ts-fsrs) and the one place where a review is recorded.

import { createEmptyCard, fsrs, generatorParameters, Rating, type FSRS, type Grade } from 'ts-fsrs';
import { cardId, dayKey, db, DEFAULT_SETTINGS, getSettings } from '../lib/db.ts';
import type { AnswerMode, CardRecord, CardType, ItemKind } from '../lib/types.ts';
import { countableMs, updateDay } from './days.ts';

const schedulers = new Map<number, FSRS>();

/** A scheduler for the given desired retention (memoized; fuzz spreads due dates). */
export function getScheduler(retention: number = DEFAULT_SETTINGS.desiredRetention): FSRS {
  let scheduler = schedulers.get(retention);
  if (!scheduler) {
    scheduler = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true }));
    schedulers.set(retention, scheduler);
  }
  return scheduler;
}

export function newCardRecord(itemId: string, kind: ItemKind, type: CardType, now: Date = new Date()): CardRecord {
  return { ...createEmptyCard(now), id: cardId(itemId, type), itemId, kind, type };
}

export interface GradeOptions {
  /** Time spent answering, ms. */
  durationMs: number;
  mode: AnswerMode;
  now?: Date;
}

/**
 * The most one answer adds to the day's study time. Anything longer means the
 * phone was put down mid-card; the review log still keeps the real duration.
 */
export const MAX_COUNTED_ANSWER_MS = 2 * 60 * 1000;

/**
 * When to schedule a review from. FSRS rejects a review dated before the last
 * one, which happens when the device clock is set back (or a backup came from
 * a device running ahead).
 */
function scheduleTime(card: CardRecord, now: Date): Date {
  return card.last_review && card.last_review > now ? card.last_review : now;
}

/**
 * Grades a card: reschedules it with FSRS, appends a ReviewLogRecord and adds the
 * review (and its answer time) to today's DayRecord, all in one transaction.
 */
export async function gradeCard(id: string, grade: Grade, { durationMs, mode, now = new Date() }: GradeOptions): Promise<CardRecord> {
  const scheduler = getScheduler((await getSettings()).desiredRetention);
  return db.transaction('rw', db.cards, db.reviewLogs, db.days, async () => {
    const card = await db.cards.get(id);
    if (!card) throw new Error(`Cannot grade unknown card "${id}"`);

    const next = scheduler.next(card, scheduleTime(card, now), grade).card;
    const updated: CardRecord = { ...card, ...next, id: card.id, itemId: card.itemId, kind: card.kind, type: card.type };
    await db.cards.put(updated);
    const answerMs = countableMs(durationMs);
    await db.reviewLogs.add({
      cardId: card.id,
      itemId: card.itemId,
      grade,
      reviewedAt: now,
      durationMs: answerMs,
      mode,
      prevState: card.state,
    });
    await updateDay(dayKey(now), (day) => {
      day.reviews += 1;
      if (grade !== Rating.Again) day.correct += 1;
      day.studyMs += Math.min(answerMs, MAX_COUNTED_ANSWER_MS);
    });
    return updated;
  });
}

/**
 * When the card would next be due for each grade (labels for self-grade
 * buttons). Pass settings.desiredRetention to match what gradeCard will do.
 */
export function previewDue(card: CardRecord, now: Date = new Date(), retention?: number): Record<1 | 2 | 3 | 4, Date> {
  const preview = getScheduler(retention).repeat(card, scheduleTime(card, now));
  return {
    1: preview[Rating.Again].card.due,
    2: preview[Rating.Hard].card.due,
    3: preview[Rating.Good].card.due,
    4: preview[Rating.Easy].card.due,
  };
}
