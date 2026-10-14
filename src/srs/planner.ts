// Today's session: due reviews (capped per day), new items, and i+1 reading.

import { State } from 'ts-fsrs';
import { dayKey, db, getSettings } from '../lib/db.ts';
import { loadKana, loadSentences } from '../lib/data.ts';
import { kanjiIn, rubyToKana } from '../lib/ruby.ts';
import type { CardRecord, SentenceEntry } from '../lib/types.ts';
import { currentPhase, knownKanaSet, nextNewItems, requiredKana, type NewItemPlan, type Phase } from './course.ts';
import { daysBetween, getDay } from './days.ts';
import { knownKanji } from './progress.ts';

export interface SessionPlan {
  /** Due card ids in the order to review them, capped by what's left of today's limit. */
  reviews: string[];
  newItems: NewItemPlan[];
  /** Set when new items are paused because of a review backlog. */
  newBlocked?: { reason: string };
  /** i+1 sentence ids to read and shadow. */
  reading: string[];
  /** Every card due now, before the daily cap. */
  backlog: number;
  estimateMinutes: number;
}

/** New items pause while more than this many reviews are due (or 2× the daily cap, if lower). */
export const BACKLOG_LIMIT = 150;

export function backlogThreshold(maxReviewsPerDay: number): number {
  return Math.min(2 * maxReviewsPerDay, BACKLOG_LIMIT);
}

function blockedReason(backlog: number, threshold: number): string {
  return (
    `New items are taking a break while you catch up on ${backlog} reviews. ` +
    `They come back once ${threshold} or fewer are waiting — reviews first keeps what you've already learned.`
  );
}

/**
 * Review order: cards still in their first steps (new, learning, relearning)
 * first, since a missed short step wastes the work just done; then the most
 * overdue review cards.
 */
export function orderReviews(cards: readonly CardRecord[]): CardRecord[] {
  const rank = (c: CardRecord) => (c.state === State.Review ? 1 : 0);
  return [...cards].sort((a, b) => rank(a) - rank(b) || a.due.getTime() - b.due.getTime());
}

async function dueCards(now: Date): Promise<CardRecord[]> {
  return db.cards.where('due').belowOrEqual(now).filter((c) => !c.suspended).toArray();
}

export async function dueCount(now: Date = new Date()): Promise<number> {
  return db.cards.where('due').belowOrEqual(now).filter((c) => !c.suspended).count();
}

const SECONDS = {
  review: 12,
  sentence: 60,
  word: 30,
  newItem: { kana: 45, radical: 40, kanji: 120, vocab: 30, grammar: 150 },
} as const;

export function estimateMinutes(reviews: number, newItems: readonly NewItemPlan[], sentences: number): number {
  let seconds = reviews * SECONDS.review + sentences * SECONDS.sentence;
  for (const item of newItems) seconds += SECONDS.newItem[item.kind] + (item.words?.length ?? 0) * SECONDS.word;
  return Math.ceil(seconds / 60);
}

/** Sentences per day: 2 while learning kana, 3 in phase 2, 4 after. */
export function readingCountFor(phase: Phase): number {
  return phase === 1 ? 2 : phase === 2 ? 3 : 4;
}

export async function planToday(now: Date = new Date()): Promise<SessionPlan> {
  const settings = await getSettings();
  const today = await getDay(dayKey(now));
  const due = await dueCards(now);
  const backlog = due.length;

  const reviewRoom = Math.max(0, settings.maxReviewsPerDay - today.reviews);
  const reviews = orderReviews(due).slice(0, reviewRoom).map((c) => c.id);

  const threshold = backlogThreshold(settings.maxReviewsPerDay);
  const blocked = backlog > threshold;
  const newRoom = Math.max(0, settings.newPerDay - today.newItems);
  const newItems = blocked ? [] : await nextNewItems(newRoom, now);

  const phase = await currentPhase();
  const reading = (await pickSentences(readingCountFor(phase), { now, phase })).map((s) => s.id);

  return {
    reviews,
    newItems,
    ...(blocked ? { newBlocked: { reason: blockedReason(backlog, threshold) } } : {}),
    reading,
    backlog,
    estimateMinutes: estimateMinutes(reviews.length, newItems, reading.length),
  };
}

// ---------------------------------------------------------------------------
// Reading: i+1 sentences
// ---------------------------------------------------------------------------

export interface IPlusOneOptions {
  /** Allow sentences without any kanji (phase 1). */
  allowKanaOnly?: boolean;
  /**
   * Phase 1: kana count as things to know too. Every kana in the sentence
   * (furigana included) must be known, except for the one new thing allowed.
   */
  kana?: { course: ReadonlySet<string>; known: ReadonlySet<string> };
  /** Sentence ids to leave out (shown recently). */
  exclude?: ReadonlySet<string>;
}

/**
 * Sentences with at most one unknown kanji, best first: those using the most
 * recently learned kanji, then those with one new kanji to stretch toward, then
 * file order.
 */
export function pickIPlusOne(
  sentences: readonly SentenceEntry[],
  known: ReadonlySet<string>,
  recent: readonly string[] = [],
  opts: IPlusOneOptions = {},
): SentenceEntry[] {
  const recency = new Map(recent.map((k, i) => [k, recent.length - i]));
  const ranked: { sentence: SentenceEntry; unknown: number; score: number; index: number }[] = [];

  sentences.forEach((sentence, index) => {
    if (opts.exclude?.has(sentence.id)) return;
    const kanji = kanjiIn(sentence.jp);
    if (!kanji.length && !opts.allowKanaOnly) return;
    let unknown = kanji.filter((k) => !known.has(k)).length;
    if (opts.kana) {
      const { course, known: knownKana } = opts.kana;
      unknown += new Set(requiredKana(rubyToKana(sentence.jp), course).filter((k) => !knownKana.has(k))).size;
    }
    if (unknown > 1) return;
    const score = Math.max(0, ...kanji.map((k) => recency.get(k) ?? 0));
    ranked.push({ sentence, unknown, score, index });
  });

  return ranked
    .sort((a, b) => b.score - a.score || b.unknown - a.unknown || a.index - b.index)
    .map((r) => r.sentence);
}

const SHOWN_KEY = 'issho.srs.sentencesShown';
/** Sentences shown within this many days are skipped. */
export const SHOWN_COOLDOWN_DAYS = 7;
let shownFallback: Record<string, string> = {};

// Per-device memory of when each sentence was last shown: id → day key. Kept in
// localStorage (with an in-memory fallback when storage is unavailable).
function readShown(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHOWN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : shownFallback;
  } catch {
    return shownFallback;
  }
}

function writeShown(shown: Record<string, string>): void {
  shownFallback = shown;
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify(shown));
  } catch {
    // Storage full or blocked: the in-memory copy still covers this visit.
  }
}

function recentlyShown(today: string): Set<string> {
  const shown = readShown();
  return new Set(Object.keys(shown).filter((id) => daysBetween(shown[id], today) < SHOWN_COOLDOWN_DAYS));
}

/** Records that these sentences were shown today, so they rest for a week. */
export function markSentencesShown(ids: readonly string[], now: Date = new Date()): void {
  const today = dayKey(now);
  const shown = readShown();
  const kept = Object.fromEntries(Object.entries(shown).filter(([, day]) => daysBetween(day, today) < 30));
  for (const id of ids) kept[id] = today;
  writeShown(kept);
}

/** Kanji introduced most recently first. */
async function recentKanji(limit: number): Promise<string[]> {
  return (await knownKanji()).slice(-limit).reverse();
}

export interface PickSentencesOptions {
  now?: Date;
  /** Current phase, when the caller already knows it. */
  phase?: Phase;
}

/** Up to `n` i+1 sentences for today (see pickIPlusOne). */
export async function pickSentences(n: number, { now = new Date(), phase }: PickSentencesOptions = {}): Promise<SentenceEntry[]> {
  const [sentences, kanaList] = await Promise.all([loadSentences(), loadKana()]);
  const p = phase ?? (await currentPhase());
  const known = new Set(await knownKanji());
  const recent = await recentKanji(20);

  let kana: IPlusOneOptions['kana'];
  if (p === 1) {
    const { knowsHiragana, knowsKatakana } = await getSettings();
    const introduced = new Set(await db.items.where('kind').equals('kana').primaryKeys());
    kana = {
      course: new Set(kanaList.map((k) => k.char)),
      known: knownKanaSet({ kana: kanaList, introduced, knowsHiragana, knowsKatakana }),
    };
  }

  return pickIPlusOne(sentences, known, recent, {
    allowKanaOnly: p === 1,
    kana,
    exclude: recentlyShown(dayKey(now)),
  }).slice(0, n);
}
