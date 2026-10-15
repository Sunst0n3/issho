// Time governor and stream balancer (pure).
//
// Each sitting re-plans the whole day with what earlier sittings already did
// (GovToday), so a day split into sittings has the same budget as one sitting.
// Sprint days are fixed and never throttled; afterwards the day is planned in
// seconds: reviews first, a reserve for reading/output/fluency (the strand), and
// new items in whatever room is left, balanced 60/20/20 between kanji, core
// words and grammar by a deficit round-robin.

import type { DailyMinutes, StreamSeconds } from '../lib/types.ts';
import type { CourseGates, NewItemPlan, StreamCandidates } from './course.ts';
import type { TimingKey } from './timing.ts';

export const MISS_EXTRA_SEC = 8;
/** kana 53 = the plan's 35-s lesson + its first-check cards (read 6 + write 12); other prices already include the check. */
export const PRICE_SEC = { kanji: 160, anchor: 28, core: 35, staged: 28, grammar: 200, kana: 53, kanaRule: 150 } as const;
/** First-check seconds a staged release adds when it is a core word not yet introduced: it gets the core word's listen
 *  card (7) and, with `use`, its produce card (12) besides the read card PRICE_SEC.staged already covers (the
 *  DEFAULT_SECONDS of timing.ts). */
export const STAGED_NEW_CORE_SEC = { listen: 7, produce: 12 } as const;

/** pure: the price of a staged release. A spelling upgrade (read card only) or a JMdict word costs PRICE_SEC.staged; a
 *  core word not yet introduced also pays for its listen (+ produce) first-check cards, so it never costs less than a
 *  core lesson (QA V041: 八つ made 3 cards but was priced 28 s). */
export function stagedPriceSec(newCore: boolean, use: boolean): number {
  return PRICE_SEC.staged + (newCore ? STAGED_NEW_CORE_SEC.listen + (use ? STAGED_NEW_CORE_SEC.produce : 0) : 0);
}
export type SharedStream = 'kanji' | 'core' | 'grammar';
export const SHARED_STREAMS: readonly SharedStream[] = ['kanji', 'core', 'grammar'];
export const STREAM_TARGETS: Record<SharedStream, number> = { kanji: 0.6, core: 0.2, grammar: 0.2 };
export const CEILINGS = { kanji: 3, core: 3, staged: 4, grammar: 1 } as const;
export const GRAMMAR_FLOOR_PER_WEEK = 2;
export const RMAX: Record<DailyMinutes, number> = { 20: 6, 25: 8, 30: 9, 40: 10 };
export const WORDS_FOR_RMAX = 1200;
export const FORECAST_FACTOR = 1.12;
export const HARD_CAP_FACTOR = 1.1;
export const SAFETY_CAP_REVIEWS = 400;
export const BRAKE_BELOW = 0.8;
export const EXTRA_KANJI_AT = 0.95;
export const CATCH_UP_STRAND_MIN = 2;
export const CATCH_UP_MARGIN_MIN = 3;

/** R in minutes: d ≤ 14 → 2; d ≤ 60 → 4; until 1,200 known words → 6; then RMAX[budget]; never above RMAX. */
export function strandMinutes(courseDay: number, wordsKnown: number, budget: DailyMinutes): number {
  const r = courseDay <= 14 ? 2 : courseDay <= 60 ? 4 : wordsKnown < WORDS_FOR_RMAX ? 6 : RMAX[budget];
  return Math.min(r, RMAX[budget]);
}

export interface GovDueCard {
  id: string;
  key: TimingKey;
  /** Retrievability now. */
  r: number;
  /** Catch-up tie-break: 2 write-list kanji, 1 'use' word, 0 rest. */
  value: 0 | 1 | 2;
}

/** Expected seconds of one review: s_t + (1 − R)(s_t + 8) (a miss costs feedback and a re-ask). */
export function cardSeconds(card: Pick<GovDueCard, 'key' | 'r'>, sec: Record<TimingKey, number>): number {
  const s = sec[card.key];
  return s + (1 - card.r) * (s + MISS_EXTRA_SEC);
}

/** Rv = Σ s_t + (1 − R_i)(s_t + 8). */
export function reviewSeconds(due: readonly GovDueCard[], sec: Record<TimingKey, number>): number {
  let total = 0;
  for (const card of due) total += cardSeconds(card, sec);
  return total;
}

/** F7 = (1/7) Σ 1.12 · s_t over cards due in the next 7 days (not due now). */
export function forecastSeconds(upcoming: readonly TimingKey[], sec: Record<TimingKey, number>): number {
  let total = 0;
  for (const key of upcoming) total += FORECAST_FACTOR * sec[key];
  return total / 7;
}

/** What earlier sittings already did today (from DayRecord). */
export interface GovToday {
  kanji: number;
  core: number;
  staged: number;
  grammar: number;
  /** DayRecord.newSec: priced seconds already introduced today, all five streams. */
  newSec: StreamSeconds;
  /** DayRecord.reviewMs / 1000: warm-up review time already spent today. */
  reviewSec: number;
  /** DayRecord.strandMs / 1000: read, output and fluency time already spent today. */
  strandSec: number;
  /** DayRecord.catchUp: an earlier sitting ran in catch-up mode (sticky for the day). */
  catchUp: boolean;
}

export interface GovernorInput {
  budgetMin: DailyMinutes;
  courseDay: number;
  gates: CourseGates;
  sprintComplete: boolean;
  wordsKnown: number;
  seconds: Record<TimingKey, number>;
  /** Due now and not yet reviewed today, siblings already resolved, in warm-up order. */
  due: GovDueCard[];
  upcoming: TimingKey[];
  candidates: StreamCandidates;
  /** New-learning seconds per shared stream over the 14 days before today. */
  spent14: Record<SharedStream, number>;
  today: GovToday;
  /** First-try success on Review-state cards (context 'review'), last 3 / 7 study days; null when < 20 reviews. */
  accuracy3: number | null;
  accuracy7: number | null;
  /** Actual study time: mean DayRecord.studyMs over the last 7 study days before today ≤ budgetMin · 60 000. */
  underBudget7: boolean;
  /** The previous study day ran in catch-up mode, or a fresh start is active (Settings.freshStart ≤ today). */
  catchUpBefore: boolean;
  travel: boolean;
  /** The learner accepted "Add one more kanji today?". */
  extraKanji: boolean;
}

export interface GovernorOutput {
  mode: 'sprint' | 'normal' | 'catch-up' | 'travel';
  strandMin: number;
  /** In input (warm-up) order, also in catch-up: the governor chooses the subset, never the order. */
  reviews: string[];
  newItems: NewItemPlan[];
  seconds: {
    /** Remaining warm-up seconds (truncated in catch-up). */
    reviews: number;
    forecast7: number;
    newRoom: number;
    newPlanned: number;
    /** Remaining strand seconds: max(0, 60·strandMin − today.strandSec). */
    strands: number;
    /** today.reviewSec + today.strandSec + Σ today.newSec. */
    doneToday: number;
    /** Remaining: reviews + newPlanned + strands. "About N min (left) today" = ceil(total / 60). */
    total: number;
    /** doneToday + total. */
    dayTotal: number;
  };
  brake: boolean;
  offerExtraKanji: boolean;
}

function sumStreams(s: StreamSeconds): number {
  return s.sprint + s.kanji + s.staged + s.core + s.grammar;
}

function sumPrices(items: readonly NewItemPlan[]): number {
  let total = 0;
  for (const item of items) total += item.priceSec;
  return total;
}

/** The first SAFETY_CAP_REVIEWS due cards, in input order, and their seconds. */
function cappedReviews(due: readonly GovDueCard[], sec: Record<TimingKey, number>): { ids: string[]; seconds: number } {
  const shown = due.slice(0, SAFETY_CAP_REVIEWS);
  return { ids: shown.map((c) => c.id), seconds: reviewSeconds(shown, sec) };
}

interface Fill {
  items: NewItemPlan[];
  /** Planned seconds per stream (all five). */
  planned: StreamSeconds;
  room: number;
}

/** Adds the item when its price fits the room left. */
function tryAdd(fill: Fill, item: NewItemPlan): boolean {
  if (item.priceSec > fill.room + 1e-9) return false;
  fill.items.push(item);
  fill.planned[item.stream] += item.priceSec;
  fill.room -= item.priceSec;
  return true;
}

function ceilingOf(stream: SharedStream, extraKanji: boolean): number {
  return stream === 'kanji' ? CEILINGS.kanji + (extraKanji ? 1 : 0) : CEILINGS[stream];
}

/**
 * The deficit round-robin over kanji, core and grammar. A stream whose next item does not fit is
 * closed for the rest of the fill, so curriculum order holds (a later, cheaper zero-word kanji
 * never jumps ahead) and the loop ends.
 */
function fillShared(fill: Fill, input: GovernorInput, counts: Record<SharedStream, number>): void {
  const { candidates, spent14, today, extraKanji } = input;
  const queues: Record<SharedStream, NewItemPlan[]> = {
    kanji: [...candidates.kanji],
    core: [...candidates.core],
    grammar: candidates.grammar && !fill.items.includes(candidates.grammar) ? [candidates.grammar] : [],
  };
  const open: Record<SharedStream, boolean> = { kanji: true, core: true, grammar: true };
  for (;;) {
    const total = SHARED_STREAMS.reduce((sum, k) => sum + spent14[k] + today.newSec[k] + fill.planned[k], 0);
    let best: SharedStream | null = null;
    let bestDeficit = -Infinity;
    for (const k of SHARED_STREAMS) {
      if (!open[k] || !queues[k].length || counts[k] >= ceilingOf(k, extraKanji)) continue;
      const share = total > 0 ? (spent14[k] + today.newSec[k] + fill.planned[k]) / total : 0;
      const deficit = STREAM_TARGETS[k] - share;
      if (deficit > bestDeficit + 1e-12) {
        best = k;
        bestDeficit = deficit;
      }
    }
    if (!best) return;
    const next = queues[best][0];
    if (tryAdd(fill, next)) {
      queues[best].shift();
      counts[best]++;
    } else {
      open[best] = false;
    }
  }
}

export function govern(input: GovernorInput): GovernorOutput {
  const { budgetMin, courseDay, gates, today, candidates, seconds: sec } = input;
  const B = budgetMin * 60;
  const cap = HARD_CAP_FACTOR * B;
  const R = strandMinutes(courseDay, input.wordsKnown, budgetMin);
  const LF = B - 60 * R;
  const Rv = reviewSeconds(input.due, sec);
  const RvDay = Rv + today.reviewSec;
  const newDone = sumStreams(today.newSec);
  const F7 = forecastSeconds(input.upcoming, sec);
  const doneToday = today.reviewSec + today.strandSec + newDone;

  const result = (
    mode: GovernorOutput['mode'],
    strandMin: number,
    reviews: { ids: string[]; seconds: number },
    newItems: NewItemPlan[],
    newRoom: number,
    extra: { brake?: boolean; offerExtraKanji?: boolean; strands?: number } = {},
  ): GovernorOutput => {
    const newPlanned = sumPrices(newItems);
    const strands = extra.strands ?? Math.max(0, 60 * strandMin - today.strandSec);
    const total = reviews.seconds + newPlanned + strands;
    return {
      mode,
      strandMin,
      reviews: reviews.ids,
      newItems,
      seconds: {
        reviews: reviews.seconds,
        forecast7: F7,
        newRoom: Math.max(0, newRoom),
        newPlanned,
        strands,
        doneToday,
        total,
        dayTotal: doneToday + total,
      },
      brake: extra.brake ?? false,
      offerExtraKanji: extra.offerExtraKanji ?? false,
    };
  };

  // 1. Travel: reviews are optional, nothing new, no strand.
  if (input.travel) {
    return result('travel', 0, cappedReviews(input.due, sec), [], 0);
  }

  // 2. Sprint: fixed content, never throttled, never catch-up.
  if (courseDay < gates.governorFrom || !input.sprintComplete) {
    const items: NewItemPlan[] = [...candidates.kana];
    if (candidates.kanaRule) items.push(candidates.kanaRule);
    if (courseDay >= gates.coreFrom) items.push(...candidates.core.slice(0, Math.max(0, CEILINGS.core - today.core)));
    const grammar = candidates.grammar;
    if (grammar && today.grammar < CEILINGS.grammar && RvDay + newDone + sumPrices(items) + grammar.priceSec + 60 * R <= cap) {
      items.push(grammar);
    }
    return result('sprint', R, cappedReviews(input.due, sec), items, 0);
  }

  // 3. Catch-up: entered when the review load is over budget (with hysteresis), sticky for the day.
  if (RvDay > B || (input.catchUpBefore && RvDay > LF) || today.catchUp) {
    const limit = Math.max(0, (budgetMin - CATCH_UP_MARGIN_MIN) * 60 - today.reviewSec);
    const ranked = input.due
      .map((card, index) => ({ card, index }))
      .sort((a, b) => a.card.r - b.card.r || b.card.value - a.card.value || a.index - b.index);
    const chosen = new Set<number>();
    let running = 0;
    for (const { card, index } of ranked) {
      const s = cardSeconds(card, sec);
      if (running + s > limit + 1e-9) break;
      running += s;
      chosen.add(index);
    }
    const ids = input.due.filter((_, i) => chosen.has(i)).map((c) => c.id);
    const strands = Math.max(0, 60 * CATCH_UP_STRAND_MIN - today.strandSec);
    return result('catch-up', CATCH_UP_STRAND_MIN, { ids, seconds: running }, [], 0, { strands });
  }

  // 4. Normal.
  let newRoom = LF - Math.max(RvDay, F7) - 60 - newDone - Math.max(0, today.strandSec - 60 * R);
  let brake = false;
  if (input.accuracy3 !== null && input.accuracy3 < BRAKE_BELOW && newRoom > 0) {
    newRoom *= 0.5;
    brake = true;
  }
  const strandDay = Math.max(60 * R, today.strandSec);
  newRoom = Math.min(newRoom, cap - RvDay - strandDay - newDone);

  let strandMin = R;
  if (RvDay + newDone + 60 * R > cap) {
    strandMin = Math.max(CATCH_UP_STRAND_MIN, Math.floor((cap - RvDay - newDone) / 60));
  }

  const fill: Fill = {
    items: [],
    planned: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 },
    room: Math.max(0, newRoom),
  };
  const counts: Record<SharedStream, number> = { kanji: today.kanji, core: today.core, grammar: today.grammar };

  // 4.1 Staged releases (outside the 60/20/20 shares).
  let staged = today.staged;
  for (const item of candidates.staged) {
    if (staged >= CEILINGS.staged) break;
    if (tryAdd(fill, item)) staged++;
  }
  // 4.2 Below the weekly grammar floor: grammar goes ahead of kanji.
  if (candidates.grammarBelowFloor && candidates.grammar && counts.grammar < CEILINGS.grammar) {
    if (tryAdd(fill, candidates.grammar)) counts.grammar++;
  }
  // 4.3 Deficit round-robin.
  fillShared(fill, input, counts);

  // "Add one more kanji today?": only once today's kanji reached the ceiling, and only when a 188-s
  // kanji would still fit both the room and the 1.1·B cap (accepting re-plans with ceiling 4).
  const reviews = cappedReviews(input.due, sec);
  const plannedKanji = fill.items.filter((i) => i.stream === 'kanji').length;
  const nextKanji = candidates.kanji[plannedKanji];
  const strands = Math.max(0, 60 * strandMin - today.strandSec);
  const dayTotal = doneToday + reviews.seconds + sumPrices(fill.items) + strands;
  const extraPrice = PRICE_SEC.kanji + PRICE_SEC.anchor;
  const offerExtraKanji =
    !input.extraKanji &&
    input.accuracy7 !== null &&
    input.accuracy7 >= EXTRA_KANJI_AT &&
    input.underBudget7 &&
    nextKanji !== undefined &&
    counts.kanji >= CEILINGS.kanji &&
    nextKanji.priceSec <= fill.room &&
    dayTotal + extraPrice <= cap;

  return result('normal', strandMin, reviews, fill.items, newRoom, { brake, offerExtraKanji });
}
