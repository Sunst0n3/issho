// FSRS scheduling (ts-fsrs) and the one place where a review is recorded.
//
// Two presets: production cards (write, produce, build, cloze) always aim at
// PRODUCTION_RETENTION; receptive cards (read, meaning, listen, comprehend) at the
// learner's Settings.receptiveRetention (0.85–0.93, never above 0.95).

import { createEmptyCard, fsrs, generatorParameters, Rating, State, type FSRS, type Grade } from 'ts-fsrs';
import { cardId, dayKey, db, DEFAULT_SETTINGS, getSettings, normalizeRetention, PRODUCTION_RETENTION } from '../lib/db.ts';
import type {
  AnswerMode,
  CardRecord,
  CardType,
  FsrsPreset,
  ItemKind,
  QuizVerdict,
  ReviewContext,
  ReviewLogRecord,
  Settings,
} from '../lib/types.ts';
import { countableMs, DAY_MS, updateDay } from './days.ts';

const PRODUCTION_TYPES: ReadonlySet<CardType> = new Set<CardType>(['write', 'produce', 'build', 'cloze']);

/** pure: write, produce, build, cloze → 'production'; read, meaning, listen, comprehend → 'receptive'. */
export function presetOf(type: CardType): FsrsPreset {
  return PRODUCTION_TYPES.has(type) ? 'production' : 'receptive';
}

/** pure: production → PRODUCTION_RETENTION (0.9); receptive → normalizeRetention(settings.receptiveRetention). */
export function retentionFor(preset: FsrsPreset, settings: Pick<Settings, 'receptiveRetention'>): number {
  return preset === 'production' ? PRODUCTION_RETENTION : normalizeRetention(settings.receptiveRetention);
}

export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.95;

const schedulers = new Map<string, FSRS>();

/**
 * A scheduler for one desired retention (and optional weights), memoized. Fuzz spreads due dates;
 * learning steps 1m/10m and relearning 10m are the ts-fsrs defaults. Throws RangeError outside 0.7–0.95.
 */
export function getScheduler(retention: number, weights?: readonly number[]): FSRS {
  if (!Number.isFinite(retention) || retention > MAX_RETENTION || retention < MIN_RETENTION) {
    throw new RangeError(`Desired retention ${retention} is outside ${MIN_RETENTION}–${MAX_RETENTION}`);
  }
  const key = weights?.length ? `${retention}|${weights.join(',')}` : String(retention);
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = fsrs(generatorParameters({
      request_retention: retention,
      enable_fuzz: true,
      maximum_interval: 36500,
      learning_steps: ['1m', '10m'],
      relearning_steps: ['10m'],
      ...(weights?.length ? { w: [...weights] } : {}),
    }));
    schedulers.set(key, scheduler);
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
  /** Default 'review'. */
  context?: ReviewContext;
  parts?: ReviewLogRecord['parts'];
  input?: ReviewLogRecord['input'];
  override?: boolean;
  surprise?: boolean;
  /** Answered inside a make-up session (§3.1.11): its time goes to DayRecord.makeupMs, not reviewMs. */
  makeup?: boolean;
  now?: Date;
}

/**
 * The most one answer adds to the day's study time. Anything longer means the
 * phone was put down mid-card; the review log still keeps the real duration.
 */
export const MAX_COUNTED_ANSWER_MS = 120_000;

/**
 * When to schedule a review from. FSRS rejects a review dated before the last
 * one, which happens when the device clock is set back (or a backup came from
 * a device running ahead).
 */
function scheduleTime(card: CardRecord, now: Date): Date {
  return card.last_review && card.last_review > now ? card.last_review : now;
}

/** Whole days since the card's previous review (0 for a card never reviewed). */
export function elapsedDaysOf(card: Pick<CardRecord, 'last_review' | 'state'>, now: Date): number {
  if (card.state === State.New || !card.last_review) return 0;
  return Math.max(0, Math.floor((now.getTime() - card.last_review.getTime()) / DAY_MS));
}

/** The scheduler a card is graded with, given the learner's settings. */
export function schedulerFor(type: CardType, settings: Pick<Settings, 'receptiveRetention' | 'fsrsWeights'>): FSRS {
  const preset = presetOf(type);
  return getScheduler(retentionFor(preset, settings), settings.fsrsWeights?.[preset]);
}

/** pure: the card after `grade` at `now` (identity fields kept). */
export function nextCard(card: CardRecord, grade: Grade, now: Date, scheduler: FSRS): CardRecord {
  const next = scheduler.next(card, scheduleTime(card, now), grade).card;
  return { ...card, ...next, id: card.id, itemId: card.itemId, kind: card.kind, type: card.type };
}

/**
 * Grades a card in one rw transaction over [cards, reviewLogs, days, settings, items] (joining an
 * enclosing transaction that covers them): FSRS next() with the card's preset retention, the full
 * ReviewLogRecord, and today's DayRecord (reviews, correct, studyMs; reviewMs for 'review' and
 * 're-ask' answers, makeupMs for make-up answers). Partner grades add no study time: the together
 * session accounts for it.
 */
export function gradeCard(id: string, grade: Grade, opts: GradeOptions): Promise<CardRecord> {
  const { durationMs, mode, context = 'review', now = new Date() } = opts;
  return db.transaction('rw', [db.cards, db.reviewLogs, db.days, db.settings, db.items], async () => {
    const card = await db.cards.get(id);
    if (!card) throw new Error(`Cannot grade unknown card "${id}"`);
    const settings = await getSettings();
    const updated = nextCard(card, grade, now, schedulerFor(card.type, settings));
    await db.cards.put(updated);

    const answerMs = countableMs(durationMs);
    const log: ReviewLogRecord = {
      cardId: card.id,
      itemId: card.itemId,
      kind: card.kind,
      type: card.type,
      grade,
      reviewedAt: now,
      durationMs: answerMs,
      mode,
      prevState: card.state,
      elapsedDays: elapsedDaysOf(card, now),
      context,
    };
    if (opts.parts) log.parts = opts.parts;
    if (opts.input) log.input = opts.input;
    if (opts.override) log.override = true;
    if (opts.surprise) log.surprise = true;
    await db.reviewLogs.add(log);

    const counted = mode === 'partner' ? 0 : Math.min(answerMs, MAX_COUNTED_ANSWER_MS);
    await updateDay(dayKey(now), (day) => {
      day.reviews += 1;
      if (grade !== Rating.Again) day.correct += 1;
      day.studyMs += counted;
      if (opts.makeup) day.makeupMs = (day.makeupMs ?? 0) + counted;
      else if (context === 'review' || context === 're-ask') day.reviewMs += counted;
    });
    return updated;
  });
}

/**
 * When the card would next be due for each grade (labels for self-grade buttons). Pass the
 * card's preset retention (retentionFor) to match what gradeCard will do.
 */
export function previewDue(card: CardRecord, now: Date = new Date(), retention?: number): Record<1 | 2 | 3 | 4, Date> {
  const r = retention ?? retentionFor(presetOf(card.type), DEFAULT_SETTINGS);
  const preview = getScheduler(r).repeat(card, scheduleTime(card, now));
  return {
    1: preview[Rating.Again].card.due,
    2: preview[Rating.Hard].card.due,
    3: preview[Rating.Good].card.due,
    4: preview[Rating.Easy].card.due,
  };
}

/**
 * pure: 1 for New cards, else the FSRS probability of recall at `now`. The forgetting curve
 * depends on the weights and stability only, not on the desired retention.
 */
export function retrievability(card: CardRecord, now: Date): number {
  if (card.state === State.New || !card.last_review) return 1;
  const r = getScheduler(retentionFor(presetOf(card.type), DEFAULT_SETTINGS)).get_retrievability(card, now, false);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1;
}

/** A partner's verdict as an FSRS grade. */
export const PARTNER_GRADE: Record<QuizVerdict, Grade> = {
  right: Rating.Good,
  close: Rating.Hard,
  wrong: Rating.Again,
};
export const PARTNER_WINDOW_DAYS = 2;

/** pure: |due − now| ≤ 2 days, not suspended, not New. */
export function inPartnerWindow(card: CardRecord, now: Date): boolean {
  if (card.suspended || card.state === State.New) return false;
  return Math.abs(card.due.getTime() - now.getTime()) <= PARTNER_WINDOW_DAYS * DAY_MS;
}
