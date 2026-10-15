// Today's plan, re-made at the start of every sitting: the warm-up (due cards not
// yet reviewed today, in order, siblings buried), the new items the governor
// priced into what is left of the day, the first check of every New card, and the
// read, output and fluency steps. Also the 3-minute micro plan and the make-up.

import { State } from 'ts-fsrs';
import { clipRef } from '../../shared/voicevox.ts';
import { dayKey, db, getSettings, updateSettings } from '../lib/db.ts';
import { loadKanaExamples, loadSentences, loadWordInfo } from '../lib/data.ts';
import { rubyToKana, rubyToPlain } from '../lib/ruby.ts';
import type {
  CardRecord,
  CardType,
  DailyMinutes,
  DailyStepId,
  DayRecord,
  FluencyKind,
  ItemKind,
  ItemRecord,
  KanaRule,
  OutputTarget,
  ReviewLogRecord,
  Settings,
  WordRef,
} from '../lib/types.ts';
import { buildSnapshot, loadCourseSnapshot, streamCandidates, taughtKanaFrom, type CourseSnapshot, type NewItemPlan } from './course.ts';
import {
  addDays,
  DAY_MS,
  daysBetween,
  dayStart,
  emptyStreamSeconds,
  getDay,
  normalizeDay,
  studyDayLookback,
  totalNewSec,
  updateDay,
  weekStart,
} from './days.ts';
import { encounterCounts } from './encounters.ts';
import { pickFluency, speedRoundCards, SPEED_ROUND_MIN_CARDS } from './fluency.ts';
import {
  cardSeconds,
  govern,
  PRICE_SEC,
  type GovDueCard,
  type GovernorInput,
  type GovernorOutput,
  type SharedStream,
} from './governor.ts';
import { cardTypesFor, syncWriteRetirement } from './items.ts';
import type { NumberDrillItem } from './numbersDrill.ts';
import { pickOutputTarget } from './output.ts';
import type { PitchItem } from './pitch.ts';
import { iPlusOneContext, pickIPlusOne, pickRead, TARGET_AGE } from './readListen.ts';
import { retrievability } from './scheduler.ts';
import { secondsPerKey, timingKeyOf, type TimingKey } from './timing.ts';
import { orderWarmup, siblingGroups, type WarmupCard } from './warmup.ts';

export { orderWarmup, siblingGroups, type WarmupCard } from './warmup.ts';

export type Sitting = 'any' | 'anywhere' | 'desk';
/** planToday returns sprint | normal | catch-up | travel. micro, welcome-back and makeup come only from planMicro / planMakeup. */
export type DayMode = 'sprint' | 'normal' | 'catch-up' | 'travel' | 'micro' | 'welcome-back' | 'makeup';

export interface TeachBatch { items: NewItemPlan[] }
export interface ReadPlan {
  kind: 'kana-words' | 'kana-check' | 'sentences' | 'story';
  /** Sprint: 2–3 real words per kana lesson, made only of taught kana (kana-examples + rule practice words), each
   *  with its clip ref ('kanaEx:<c>' or 'kanaRule:<id>#<n>'), chosen so today's kana are each read in a word.
   *  kana-check: KanaRule.checkWords (refs 'core:<id>'). After the sprint ('kana-words' with sentences after them):
   *  recent core words still in kana (introduced 1–21 days ago, nothing of theirs due or unchecked) read aloud, then
   *  heard (ref 'core:<id>'), filling the read minutes the sentences leave (READ_WORD_SECONDS each). */
  kanaWords: { kana: string; en: string; ref: string }[];
  sentences: { id: string; target: WordRef }[];
  story?: { storyId: string; step: 'rwl' | 'listen'; shared: boolean };
  /** Planned minutes (≤ the read-block minutes; a sentence ≈ 1 min, a story its clip length / rate + 1 min). */
  minutes: number;
}
export interface OutputPlan { target: OutputTarget }
export interface FluencyPlan {
  kind: FluencyKind;
  storyId?: string;
  cardIds?: string[];
  /** numbers: today's drill, only counters, time and prices whose grammar is introduced. */
  numbers?: NumberDrillItem[];
  /** pitch: today's pitch-ear items (8–12, minimal pairs together). */
  pitch?: PitchItem[];
}

export interface DayPlan {
  day: string;
  courseDay: number;
  mode: DayMode;
  sitting: Sitting;
  budgetMin: DailyMinutes;
  /** "About N min (left) today": ceil(GovernorOutput.seconds.total / 60), counting of the strand reserve only what the
   *  read, output and fluency steps still planned take (an anywhere sitting: its warm-up only). */
  estimateMin: number;
  /** An earlier sitting already did something today: the UI says "left today". */
  partOfDayDone: boolean;
  /** "tomorrow about M": the governor run on tomorrow as today's plan leaves it (cards due by tomorrow's rollover with
   *  siblings buried, every card checked today, tomorrow's sprint row or new items, tomorrow's strand). */
  tomorrowMin: number;
  strandMin: number;
  /** Due cards not yet reviewed today (never New, never of items introduced today), in warm-up order. */
  warmup: string[];
  /** Siblings to bury until the next study day; applied by startSitting. */
  bury: string[];
  /** Only items not yet introduced today; batches of today's earlier sittings are never repeated. */
  teach: TeachBatch[];
  /** Every New card (reps 0, not suspended): today's earlier sittings, upgrades, or never checked. First-checked this sitting. */
  pendingCheck: string[];
  read: ReadPlan | null;
  output: OutputPlan | null;
  fluency: FluencyPlan | null;
  /** DayRecord.steps: once-a-day steps already finished. */
  doneSteps: DailyStepId[];
  /** For display. Undefined during catch-up: never show a card count then. */
  counts?: { reviews: number; newItems: number };
  brake: boolean;
  offerExtraKanji: boolean;
  /** "Write on paper" is offered (false in an anywhere sitting). */
  paperAllowed: boolean;
  courseComplete: boolean;
}

/** When the next study day starts (4 a.m., see dayKey). */
export function nextStudyDayStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(4, 0, 0, 0);
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  return start;
}

// ---------------------------------------------------------------------------
// What every plan needs
// ---------------------------------------------------------------------------

interface PlanContext {
  now: Date;
  today: string;
  settings: Settings;
  day: DayRecord;
  snapshot: CourseSnapshot;
  seconds: Record<TimingKey, number>;
  items: Map<string, ItemRecord>;
  cards: CardRecord[];
  todayLogs: ReviewLogRecord[];
  wordKanji: (itemId: string) => string[];
  ranks: Map<string, number>;
  wordUse: (itemId: string) => boolean;
}

async function planContext(now: Date): Promise<PlanContext> {
  const today = dayKey(now);
  const [settings, day, snapshot, seconds, items, cards, info, logs] = await Promise.all([
    getSettings(),
    getDay(today),
    loadCourseSnapshot(now),
    secondsPerKey(now),
    db.items.toArray(),
    db.cards.toArray(),
    loadWordInfo(),
    db.reviewLogs.where('reviewedAt').aboveOrEqual(studyDayLookback(now)).toArray(),
  ]);
  return {
    now,
    today,
    settings,
    day,
    snapshot,
    seconds,
    items: new Map(items.map((i) => [i.id, i])),
    cards,
    todayLogs: logs.filter((l) => dayKey(l.reviewedAt) === today),
    wordKanji: (itemId) => (itemId.startsWith('word:') || itemId.startsWith('core:') ? info(itemId)?.kanji ?? [] : []),
    ranks: new Map(snapshot.curriculum.units.map((u) => [u.char, u.index + 1])),
    wordUse: (itemId) => info(itemId)?.use ?? false,
  };
}

function introducedDay(ctx: PlanContext, itemId: string): string {
  const item = ctx.items.get(itemId);
  return item ? dayKey(item.introducedAt) : ctx.today;
}

function valueOf(ctx: PlanContext, card: CardRecord): 0 | 1 | 2 {
  if (card.kind === 'kanji' && card.type === 'write') {
    const rank = ctx.ranks.get(card.itemId.slice('kanji:'.length)) ?? Number.POSITIVE_INFINITY;
    return rank <= ctx.settings.writeList ? 2 : 0;
  }
  if (card.kind === 'word' || card.kind === 'core') return ctx.wordUse(card.itemId) ? 1 : 0;
  return 0;
}

function toWarmupCard(ctx: PlanContext, card: CardRecord): WarmupCard {
  return {
    id: card.id,
    itemId: card.itemId,
    type: card.type,
    state: card.state,
    r: retrievability(card, ctx.now),
    due: card.due,
    introducedDay: introducedDay(ctx, card.itemId),
    groups: siblingGroups(card, ctx.wordKanji(card.itemId)),
    value: valueOf(ctx, card),
  };
}

/** The planToday filter: due, not New, not suspended, not of an item introduced today. */
function isWarmupCandidate(ctx: PlanContext, card: CardRecord): boolean {
  return !card.suspended && card.state !== State.New && card.due.getTime() <= ctx.now.getTime() && introducedDay(ctx, card.itemId) !== ctx.today;
}

function takenGroups(ctx: PlanContext): Set<string> {
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  const taken = new Set<string>();
  for (const log of ctx.todayLogs) {
    const card = byId.get(log.cardId);
    if (card) for (const g of siblingGroups(card, ctx.wordKanji(card.itemId))) taken.add(g);
  }
  return taken;
}

function isPending(card: CardRecord): boolean {
  return !card.suspended && card.state === State.New && card.reps === 0;
}

/** Every New card, oldest item first, production cards first within an item. */
function pendingCheck(ctx: PlanContext): string[] {
  const production = new Set(['write', 'produce', 'build', 'cloze']);
  return ctx.cards
    .filter(isPending)
    .sort((a, b) => {
      const ia = ctx.items.get(a.itemId)?.introducedAt.getTime() ?? 0;
      const ib = ctx.items.get(b.itemId)?.introducedAt.getTime() ?? 0;
      return ia - ib || Number(production.has(b.type)) - Number(production.has(a.type)) || a.id.localeCompare(b.id);
    })
    .map((c) => c.id);
}

/** Study days before today, newest last. */
function studyDays(ctx: PlanContext): readonly string[] {
  return ctx.snapshot.studyDays;
}

async function daysBefore(ctx: PlanContext, n: number): Promise<DayRecord[]> {
  const keys = Array.from({ length: n }, (_, i) => addDays(ctx.today, -(i + 1)));
  const rows = await db.days.bulkGet(keys);
  return keys.map((k, i) => normalizeDay(rows[i], k));
}

/** First-try success on Review-state cards (context 'review') over the given days; null when < 20 reviews. */
function accuracyOver(logs: readonly ReviewLogRecord[], days: ReadonlySet<string>): number | null {
  let n = 0;
  let pass = 0;
  for (const log of logs) {
    if (log.context !== 'review' || log.prevState !== State.Review || !days.has(dayKey(log.reviewedAt))) continue;
    n++;
    if (log.grade >= 2) pass++;
  }
  return n < 20 ? null : pass / n;
}

async function governorInput(ctx: PlanContext, due: GovDueCard[], extraKanji: boolean): Promise<GovernorInput> {
  const { snapshot, settings, day, today, now } = ctx;
  const last14 = await daysBefore(ctx, 14);
  const spent14: Record<SharedStream, number> = { kanji: 0, core: 0, grammar: 0 };
  for (const d of last14) {
    spent14.kanji += d.newSec.kanji;
    spent14.core += d.newSec.core;
    spent14.grammar += d.newSec.grammar;
  }

  const recent = studyDays(ctx).slice(-7);
  const recentRows = (await db.days.bulkGet([...recent])).map((r, i) => normalizeDay(r, recent[i]));
  const since = recent.length ? dayStart(recent[0]) : now;
  const logs = recent.length ? await db.reviewLogs.where('reviewedAt').between(since, now, true, true).toArray() : [];
  const underBudget7 = recentRows.length > 0 && recentRows.reduce((s, d) => s + d.studyMs, 0) / recentRows.length <= settings.dailyMinutes * 60_000;
  const previous = recentRows.at(-1);
  const freshStartActive = settings.freshStart !== undefined && settings.freshStart <= today;

  const upcoming: TimingKey[] = [];
  const horizon = now.getTime() + 7 * DAY_MS;
  for (const card of ctx.cards) {
    if (card.suspended || card.state === State.New) continue;
    const t = card.due.getTime();
    if (t > now.getTime() && t <= horizon) upcoming.push(timingKeyOf(card.kind, card.type));
  }

  const introducedToday = [...ctx.items.values()].filter((i) => dayKey(i.introducedAt) === today && i.via === 'lesson');
  // Staged releases today: rows released today, except a core word whose own lesson today released its row.
  const stagedToday = snapshot.staged.filter(
    (r) => r.releasedAt !== undefined && dayKey(r.releasedAt) === today && !introducedToday.some((i) => i.id === r.itemId),
  ).length;
  return {
    budgetMin: settings.dailyMinutes,
    courseDay: snapshot.courseDay,
    gates: snapshot.gates,
    sprintComplete: snapshot.sprintComplete,
    wordsKnown: [...ctx.items.values()].filter((i) => i.kind === 'word' || i.kind === 'core').length,
    seconds: ctx.seconds,
    due,
    upcoming,
    candidates: streamCandidates(snapshot),
    spent14,
    today: {
      kanji: introducedToday.filter((i) => i.kind === 'kanji').length,
      core: Math.round(day.newSec.core / PRICE_SEC.core),
      staged: stagedToday,
      grammar: introducedToday.filter((i) => i.kind === 'grammar').length,
      newSec: { ...day.newSec },
      reviewSec: day.reviewMs / 1000,
      strandSec: day.strandMs / 1000,
      catchUp: day.catchUp ?? false,
    },
    accuracy3: accuracyOver(logs, new Set(recent.slice(-3))),
    accuracy7: accuracyOver(logs, new Set(recent)),
    underBudget7,
    catchUpBefore: (previous?.catchUp ?? false) || freshStartActive,
    travel: snapshot.travel,
    extraKanji,
  };
}

function govDue(ctx: PlanContext, order: readonly string[], warm: ReadonlyMap<string, WarmupCard>): GovDueCard[] {
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  return order.map((id) => {
    const card = byId.get(id)!;
    const w = warm.get(id)!;
    return { id, key: timingKeyOf(card.kind, card.type), r: w.r, value: w.value };
  });
}

/** Teach batches: sprint kana in fives, a rule on its own, else up to 4 (kanji, staged, core, grammar last). */
export function batchItems(items: readonly NewItemPlan[]): TeachBatch[] {
  const batches: TeachBatch[] = [];
  const chunk = (list: NewItemPlan[], size: number) => {
    for (let i = 0; i < list.length; i += size) batches.push({ items: list.slice(i, i + size) });
  };
  chunk(items.filter((i) => i.kind === 'kana'), 5);
  chunk(items.filter((i) => i.kind === 'kanaRule'), 1);
  const order = ['kanji', 'staged', 'core', 'grammar'] as const;
  chunk(order.flatMap((kind) => items.filter((i) => i.kind === kind)), 4);
  return batches;
}

/** Retrievability assumed for tomorrow's first review of a card learned today (checked today, then a night). */
export const FIRST_NIGHT_R = 0.9;

interface PlannedCard { itemId: string; kind: ItemKind; type: CardType }

/** The cards a planned new item will create (introducePlanItem's table), for tomorrow's estimate. */
function plannedCards(ctx: PlanContext, item: NewItemPlan): PlannedCard[] {
  const cardsOf = (itemId: string, kind: ItemKind, types: readonly CardType[]) => types.map((type) => ({ itemId, kind, type }));
  const wordCards = (ref: string): PlannedCard[] => {
    const kind: ItemKind = ref.startsWith('core:') ? 'core' : 'word';
    if (kind === 'core' && ctx.items.has(ref)) return cardsOf(ref, kind, ['read']); // spelling upgrade
    return cardsOf(ref, kind, cardTypesFor(kind, ref, { use: ctx.wordUse(ref), spelled: true }));
  };
  switch (item.kind) {
    case 'kana':
    case 'kanaRule':
      return cardsOf(item.itemId, item.kind, cardTypesFor(item.kind, item.key));
    case 'kanji':
      return [...cardsOf(item.itemId, 'kanji', cardTypesFor('kanji', item.key, { zeroWord: !item.anchor })), ...(item.anchor ? wordCards(item.anchor) : [])];
    case 'core':
      return cardsOf(item.itemId, 'core', cardTypesFor('core', item.key, { use: ctx.wordUse(item.itemId) }));
    case 'grammar': {
      const recognitionOnly = ctx.snapshot.grammar.find((g) => g.id === item.key)?.recognitionOnly ?? false;
      return cardsOf(item.itemId, 'grammar', cardTypesFor('grammar', item.key, { recognitionOnly }));
    }
    case 'staged':
      return wordCards(item.itemId);
  }
}

/**
 * "Tomorrow about M": the governor run on tomorrow as today's plan leaves it. Tomorrow's warm-up is every card due by
 * tomorrow's rollover that today's warm-up does not review, plus every card checked today (today's New cards and the
 * cards of today's new items), with siblings buried as tomorrow's order would; the new items are tomorrow's own
 * candidates (the next sprint row, or what the governor prices into tomorrow's room); the strand is tomorrow's. So
 * the estimate is what tomorrow will plan, at or under 1.1 × budget outside the sprint, and reviews only on a travel day.
 */
async function tomorrowMinutes(
  ctx: PlanContext,
  plan: { warmup: ReadonlySet<string>; newItems: readonly NewItemPlan[]; mode?: GovernorOutput['mode']; input?: GovernorInput },
): Promise<number> {
  const { snapshot, settings, now } = ctx;
  const tomorrow = addDays(ctx.today, 1);
  const at = new Date(now.getTime() + DAY_MS);
  const end = nextStudyDayStart(now).getTime() + DAY_MS;
  const input = plan.input ?? (await governorInput(ctx, [], false));

  const warm: WarmupCard[] = [];
  const keys = new Map<string, TimingKey>();
  for (const card of ctx.cards) {
    if (card.suspended || plan.warmup.has(card.id)) continue;
    const isNew = card.state === State.New;
    if (!isNew && card.due.getTime() > end) continue;
    const w = toWarmupCard(ctx, card);
    warm.push(isNew ? { ...w, state: State.Learning, r: FIRST_NIGHT_R, due: now } : { ...w, r: retrievability(card, at) });
    keys.set(card.id, timingKeyOf(card.kind, card.type));
  }
  for (const item of plan.newItems) {
    for (const c of plannedCards(ctx, item)) {
      const id = `${c.itemId}|${c.type}`;
      if (keys.has(id)) continue;
      warm.push({
        id, itemId: c.itemId, type: c.type, state: State.Learning, r: FIRST_NIGHT_R, due: now, introducedDay: ctx.today,
        groups: siblingGroups(c, ctx.wordKanji(c.itemId)), value: 0,
      });
      keys.set(id, timingKeyOf(c.kind, c.type));
    }
  }
  const ordered = orderWarmup(warm, { yesterday: ctx.today, takenGroups: new Set(), catchUp: false, seed: tomorrow });
  const warmById = new Map(warm.map((w) => [w.id, w]));
  const due: GovDueCard[] = ordered.order.map((id) => ({ id, key: keys.get(id)!, r: warmById.get(id)!.r, value: warmById.get(id)!.value }));

  const upcoming: TimingKey[] = [];
  const horizon = at.getTime() + 7 * DAY_MS;
  for (const card of ctx.cards) {
    if (card.suspended || card.state === State.New) continue;
    const t = card.due.getTime();
    if (t > end && t <= horizon) upcoming.push(timingKeyOf(card.kind, card.type));
  }

  // Tomorrow's course: today counts as a study day and today's new items (and kanji anchors) are introduced.
  const introduced = new Map(snapshot.introduced);
  for (const item of plan.newItems) {
    introduced.set(item.itemId, ctx.today);
    if (item.kind === 'kanji' && item.anchor) introduced.set(item.anchor, ctx.today);
  }
  const released = new Set(plan.newItems.filter((i) => i.kind === 'staged').map((i) => i.itemId));
  const next = buildSnapshot(
    { kana: snapshot.kana, rules: snapshot.rules, curriculum: snapshot.curriculum, core: snapshot.core, grammar: snapshot.grammar, components: snapshot.components },
    {
      today: tomorrow,
      known: snapshot.known,
      introduced,
      studyDays: [...snapshot.studyDays, ctx.today],
      staged: snapshot.staged.filter((r) => !released.has(r.itemId)),
      travel: settings.travelUntil !== undefined && settings.travelUntil >= tomorrow,
    },
  );
  const planned = (stream: SharedStream) => ctx.day.newSec[stream] + plan.newItems.filter((i) => i.stream === stream).reduce((sum, i) => sum + i.priceSec, 0);
  const newWords = plan.newItems.filter((i) => i.kind === 'core' || (i.kind === 'staged' && !i.upgrade) || (i.kind === 'kanji' && i.anchor)).length;
  const mode = plan.mode ?? (ctx.day.catchUp ? 'catch-up' : undefined);
  const freshStart = settings.freshStart !== undefined && settings.freshStart <= tomorrow && mode !== 'normal';
  const out = govern({
    ...input,
    courseDay: next.courseDay,
    gates: next.gates,
    sprintComplete: next.sprintComplete,
    wordsKnown: input.wordsKnown + newWords,
    due,
    upcoming,
    candidates: streamCandidates(next),
    spent14: { kanji: input.spent14.kanji + planned('kanji'), core: input.spent14.core + planned('core'), grammar: input.spent14.grammar + planned('grammar') },
    today: { kanji: 0, core: 0, staged: 0, grammar: 0, newSec: emptyStreamSeconds(), reviewSec: 0, strandSec: 0, catchUp: false },
    catchUpBefore: mode === 'catch-up' || freshStart,
    travel: next.travel,
    extraKanji: false,
  });
  return Math.ceil(out.seconds.total / 60);
}

function courseComplete(s: CourseSnapshot): boolean {
  const has = (id: string) => s.introduced.has(id);
  return (
    s.sprintComplete &&
    s.curriculum.units.every((u) => has(`kanji:${u.char}`)) &&
    s.core.every((w) => has(`core:${w.id}`)) &&
    s.grammar.every((g) => has(`grammar:${g.id}`))
  );
}

// ---------------------------------------------------------------------------
// The sprint read block
// ---------------------------------------------------------------------------

export const KANA_WORDS_PER_LESSON = 3;

/** Characters of a kana word, yōon and small kana attached to the kana before them. */
function kanaUnits(text: string): string[] {
  return [...text.matchAll(/.[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ]?/gu)].map((m) => m[0]);
}

/** Readable with these kana: every unit taught (っ, ッ and ー need no lesson). */
function readableWith(text: string, taught: ReadonlySet<string>): boolean {
  return kanaUnits(text).every((u) => taught.has(u) || /^[っッー]$/.test(u) || [...u].every((c) => taught.has(c)));
}

async function sprintRead(ctx: PlanContext, teach: readonly NewItemPlan[], kanaCheck: boolean): Promise<ReadPlan | null> {
  const { snapshot } = ctx;
  if (kanaCheck) {
    const rule = snapshot.rules.find((r) => r.checkWords?.length);
    if (rule?.checkWords?.length) {
      return {
        kind: 'kana-check',
        kanaWords: rule.checkWords.map((w) => ({ kana: w.kana, en: w.en, ref: w.ref })),
        sentences: [],
        minutes: 2,
      };
    }
  }
  const taughtIds = new Set(snapshot.introduced.keys());
  for (const item of teach) taughtIds.add(item.itemId);
  const taught = taughtKanaFrom(snapshot.rules, taughtIds);

  // Today's lessons: sprint kana taught today (earlier sittings and this plan), and today's rule. The known script's
  // kana and rules that a same-day placement check introduced are not lessons.
  const sprintKana = new Set(snapshot.sprint.flatMap((d) => d.kana));
  const sprintRules = new Set(snapshot.sprint.flatMap((d) => (d.rule ? [d.rule] : [])));
  const taughtToday = (prefix: 'kana:' | 'kanaRule:', inSprint: (key: string) => boolean) =>
    [...snapshot.introduced]
      .filter(([id, d]) => d === ctx.today && id.startsWith(prefix) && inSprint(id.slice(prefix.length)))
      .map(([id]) => id.slice(prefix.length));
  const todayKana = [
    ...taughtToday('kana:', (c) => sprintKana.has(c)),
    ...teach.filter((i) => i.kind === 'kana').map((i) => i.key),
  ];
  const todayRules = [
    ...taughtToday('kanaRule:', (id) => sprintRules.has(id as KanaRule['id'])),
    ...teach.filter((i) => i.kind === 'kanaRule').map((i) => i.key),
  ];
  const lessons = Math.ceil(todayKana.length / 5);
  const examples = await loadKanaExamples();
  const words: ReadPlan['kanaWords'] = [];
  const seen = new Set<string>();
  const addWord = (kana: string, en: string, ref: string) => {
    if (seen.has(kana)) return;
    seen.add(kana);
    words.push({ kana, en, ref });
  };
  const limit = lessons * KANA_WORDS_PER_LESSON;
  const candidates = Object.entries(examples).filter(([, ex]) => readableWith(ex.kana, taught));
  // Each word is the reading retrieval of its kana's read card, so every kana taught today should be read in some word:
  // greedy cover, the word reading most of today's not-yet-read kana first (ties: chart order of the example's kana).
  const unread = new Set(todayKana);
  for (;;) {
    let best: [string, { kana: string; en: string }] | undefined;
    let gain = 0;
    for (const entry of candidates) {
      if (seen.has(entry[1].kana)) continue;
      const g = new Set([...entry[1].kana].filter((c) => unread.has(c))).size;
      if (g > gain) [best, gain] = [entry, g];
    }
    if (!best || words.length >= limit) break;
    addWord(best[1].kana, best[1].en, clipRef.kanaEx(best[0]));
    for (const c of best[1].kana) unread.delete(c);
  }
  // Then other words with today's kana, then any other readable example.
  const usesToday = (kana: string) => kanaUnits(kana).some((u) => todayKana.includes(u));
  for (const [char, ex] of [...candidates.filter(([, ex]) => usesToday(ex.kana)), ...candidates.filter(([, ex]) => !usesToday(ex.kana))]) {
    if (words.length >= limit) break;
    addWord(ex.kana, ex.en, clipRef.kanaEx(char));
  }
  for (const ruleId of todayRules) {
    const rule: KanaRule | undefined = snapshot.rules.find((r) => r.id === ruleId);
    rule?.practiceWords.forEach((w, n) => {
      if (n < KANA_WORDS_PER_LESSON && readableWith(w.kana, taught)) addWord(w.kana, w.en, clipRef.kanaRule(rule.id, n));
    });
  }

  // From about day 5: kana-only i+1 sentences the learner can read.
  const sentences = (await loadSentences()).filter((s) => {
    const plain = rubyToPlain(s.jp);
    return plain === rubyToKana(s.jp) && readableWith(plain.replace(/[\s、。！？!?「」]/g, ''), taught);
  });
  const picks = sentences.length ? pickIPlusOne(sentences, await iPlusOneContext(ctx.now), 1) : [];
  if (!words.length && !picks.length) return null;
  return {
    kind: 'kana-words',
    kanaWords: words,
    sentences: picks.map((p) => ({ id: p.id, target: p.target })),
    minutes: Math.min(2, Math.ceil((words.length * 15 + picks.length * 60) / 60)),
  };
}

// ---------------------------------------------------------------------------
// Read & listen words after the sprint
// ---------------------------------------------------------------------------

/** One recent word read aloud, then heard (the sprint read's pace). */
export const READ_WORD_SECONDS = 15;

/**
 * Recent words for the read block's minutes that sentences and stories leave: core words introduced 1–21 days ago
 * that the learner still knows in kana (not spelled), fewest encounters first, then newest. A word with a card never
 * checked, or due before the rollover and neither answered today nor in this sitting's warm-up (which comes before the
 * read block), is left out: reading it and hearing its meaning would give away that card's answer. Sentence targets in
 * the same block are left out too.
 */
async function recentReadWords(
  ctx: PlanContext,
  seconds: number,
  opts: { warmup: ReadonlySet<string>; skip: ReadonlySet<string> },
): Promise<ReadPlan['kanaWords']> {
  // Whole minutes of words, so the block's minutes stay whole.
  const n = Math.floor(seconds / 60 + 1e-9) * Math.round(60 / READ_WORD_SECONDS);
  if (n <= 0) return [];
  const until = nextStudyDayStart(ctx.now).getTime();
  const answered = new Set([...ctx.todayLogs.map((l) => l.cardId), ...opts.warmup]);
  const held = new Set<string>();
  for (const card of ctx.cards) {
    if (card.suspended) continue;
    if (card.state === State.New || (card.due.getTime() < until && !answered.has(card.id))) held.add(card.itemId);
  }
  const pool = [...ctx.items.values()].filter((i) => {
    if (i.kind !== 'core' || i.spelledAt !== undefined || i.via === 'placement' || opts.skip.has(i.id) || held.has(i.id)) return false;
    const age = daysBetween(dayKey(i.introducedAt), ctx.today);
    return age >= TARGET_AGE[0] && age <= TARGET_AGE[1];
  });
  if (!pool.length) return [];
  const [info, counts] = await Promise.all([loadWordInfo(), encounterCounts(pool.map((i) => i.id), ctx.now)]);
  return pool
    .sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || b.introducedAt.getTime() - a.introducedAt.getTime() || a.id.localeCompare(b.id))
    .flatMap((i) => {
      const word = info(i.id);
      return word ? [{ kana: word.kana, en: word.en, ref: clipRef.word(i.id) }] : [];
    })
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// planToday and the sitting
// ---------------------------------------------------------------------------

/** Read-only. Re-runs at the start of every sitting (Session) and on Today. */
export async function planToday(now: Date = new Date(), opts: { sitting?: Sitting; extraKanji?: boolean } = {}): Promise<DayPlan> {
  const sitting = opts.sitting ?? 'any';
  const ctx = await planContext(now);
  const { snapshot, settings, day, today } = ctx;

  // Warm-up: due cards not yet reviewed today, ordered, siblings buried.
  const warmCards = ctx.cards.filter((c) => isWarmupCandidate(ctx, c)).map((c) => toWarmupCard(ctx, c));
  const warmById = new Map(warmCards.map((w) => [w.id, w]));
  const taken = takenGroups(ctx);
  const yesterday = studyDays(ctx).at(-1) ?? null;
  let ordered = orderWarmup(warmCards, { yesterday, takenGroups: taken, catchUp: false, seed: today });
  const input = await governorInput(ctx, govDue(ctx, ordered.order, warmById), opts.extraKanji ?? false);
  let gov: GovernorOutput = govern(input);
  if (gov.mode === 'catch-up') {
    ordered = orderWarmup(warmCards, { yesterday, takenGroups: taken, catchUp: true, seed: today });
    gov = govern({ ...input, due: govDue(ctx, ordered.order, warmById) });
  }
  const mode = gov.mode;
  const anywhere = sitting === 'anywhere';
  const doneSteps = [...day.steps];
  const pending = anywhere ? [] : pendingCheck(ctx);
  const teachItems = anywhere ? [] : gov.newItems;
  const teach = batchItems(teachItems);

  // Strand steps: fluency first (it decides the read minutes), then output, then read.
  const strandOpen = !anywhere && mode !== 'travel';
  const fluency = strandOpen && !doneSteps.includes('fluency') ? await pickFluency({ strandMin: gov.strandMin, mode }, now) : null;
  const outputAllowed =
    strandOpen && !doneSteps.includes('output') && snapshot.sprintComplete && snapshot.courseDay >= snapshot.gates.kanjiFrom;
  const target = outputAllowed ? await pickOutputTarget(now) : null;
  const output = target ? { target } : null;

  let read: ReadPlan | null = null;
  if (strandOpen && !doneSteps.includes('read')) {
    if (snapshot.inSprint) {
      const completesToday =
        (snapshot.sprintComplete && snapshot.inSprint) ||
        (!snapshot.sprintComplete && sprintCompletedBy(snapshot, teachItems));
      const kanaCheckDone = completesToday && (await db.milestones.get('kana-check')) !== undefined;
      read = await sprintRead(ctx, teachItems, completesToday && !kanaCheckDone);
    } else {
      const minutes = gov.strandMin - (output ? 1 : 0) - (fluency ? 2 : 0);
      const shared = (await db.togetherPlans.get(weekStart(today)))?.plan.storyId;
      const picked = await pickRead({ minutes, sharedStoryId: shared }, now);
      // The minutes sentences leave (none qualify early in the course: their grammar comes later) go to recent words.
      if (!picked.story) {
        const words = await recentReadWords(ctx, (minutes - picked.minutes) * 60, {
          warmup: new Set(gov.reviews),
          skip: new Set(picked.sentences.map((p) => p.target)),
        });
        if (words.length) {
          picked.kind = 'kana-words';
          picked.kanaWords = words;
          picked.minutes += Math.ceil((words.length * READ_WORD_SECONDS) / 60);
        }
      }
      read = picked.story || picked.sentences.length || picked.kanaWords.length ? picked : null;
    }
  }

  const warmup = gov.reviews;
  // Of the strand reserve, only what the read, output and fluency steps still planned take is time left today: once
  // a step is done (or there is nothing to read), "About N min left" must not count its unused minutes.
  const stepSec = (read ? read.minutes * 60 : 0) + (output ? 60 : 0) + (fluency ? 120 : 0);
  const strandLeft = Math.min(gov.seconds.strands, stepSec);
  const total = anywhere ? gov.seconds.reviews : gov.seconds.total - gov.seconds.strands + strandLeft;
  return {
    day: today,
    courseDay: snapshot.courseDay,
    mode,
    sitting,
    budgetMin: settings.dailyMinutes,
    estimateMin: Math.ceil(total / 60),
    partOfDayDone: gov.seconds.doneToday > 0,
    tomorrowMin: await tomorrowMinutes(ctx, { warmup: new Set(warmup), newItems: gov.newItems, mode, input }),
    strandMin: anywhere ? 0 : gov.strandMin,
    warmup,
    bury: ordered.bury,
    teach,
    pendingCheck: pending,
    read,
    output,
    fluency,
    doneSteps,
    ...(mode === 'catch-up' ? {} : { counts: { reviews: warmup.length, newItems: teachItems.length } }),
    brake: gov.brake,
    offerExtraKanji: anywhere ? false : gov.offerExtraKanji,
    paperAllowed: !anywhere,
    courseComplete: courseComplete(snapshot),
  };
}

/** Whether this plan's teach holds the last sprint items. */
function sprintCompletedBy(s: CourseSnapshot, items: readonly NewItemPlan[]): boolean {
  const planned = new Set(items.map((i) => i.itemId));
  return s.sprint.every(
    (d) => d.kana.every((c) => s.introduced.has(`kana:${c}`) || planned.has(`kana:${c}`)) && (!d.rule || s.introduced.has(`kanaRule:${d.rule}`) || planned.has(`kanaRule:${d.rule}`)),
  );
}

/**
 * Side effects at sitting start, all idempotent: bury (due = max(due, nextStudyDayStart(now)), an absolute target, so a
 * second call changes nothing), syncWriteRetirement, DayRecord.catchUp = true when plan.mode is 'catch-up' or a micro,
 * welcome-back or make-up plan has no counts (planned on a catch-up day; never reset to false within the day), and
 * Settings.freshStart cleared when plan.mode is 'normal' on or after that date.
 */
export async function startSitting(plan: DayPlan, now: Date = new Date()): Promise<void> {
  const until = nextStudyDayStart(now);
  const today = dayKey(now);
  await db.transaction('rw', db.cards, db.days, async () => {
    const cards = await db.cards.bulkGet(plan.bury);
    const moved = cards.filter((c): c is CardRecord => c !== undefined && c.due.getTime() < until.getTime()).map((c) => ({ ...c, due: until }));
    if (moved.length) await db.cards.bulkPut(moved);
    if (plan.mode === 'catch-up' || (SHORT_MODES.has(plan.mode) && plan.counts === undefined)) {
      // A short sitting on a catch-up day keeps the day in catch-up: its reviews would otherwise bring the load under
      // the budget, and the next full sitting would plan new items and show counts.
      await updateDay(today, (d) => {
        d.catchUp = true;
      });
    }
  });
  await syncWriteRetirement(now);
  if (plan.mode === 'normal') {
    const { freshStart } = await getSettings();
    if (freshStart !== undefined && freshStart <= today) await updateSettings({ freshStart: undefined });
  }
}

// ---------------------------------------------------------------------------
// Micro, welcome-back and make-up plans
// ---------------------------------------------------------------------------

const SHORT_MODES: ReadonlySet<DayMode> = new Set(['micro', 'welcome-back', 'makeup']);

export const MICRO_SECONDS = 180;
export const MAKEUP_SECONDS = 600;
/** Make-up: review-ahead seconds (the rest goes to reading and a speed round). */
export const MAKEUP_REVIEW_SECONDS = 420;
export const MAKEUP_SENTENCES = 2;

/** Lowest r first, one card per sibling group (groups reviewed today excluded), while the seconds fit. */
function pickByRetrievability(ctx: PlanContext, cards: readonly CardRecord[], limit: number): string[] {
  const taken = takenGroups(ctx);
  const ranked = cards.map((c) => toWarmupCard(ctx, c)).sort((a, b) => a.r - b.r || b.value - a.value || a.due.getTime() - b.due.getTime());
  const byId = new Map(cards.map((c) => [c.id, c]));
  const chosen: string[] = [];
  let used = 0;
  for (const w of ranked) {
    if (w.groups.some((g) => taken.has(g))) continue;
    const card = byId.get(w.id)!;
    const s = cardSeconds({ key: timingKeyOf(card.kind, card.type), r: w.r }, ctx.seconds);
    if (used + s > limit) break;
    used += s;
    chosen.push(w.id);
    for (const g of w.groups) taken.add(g);
  }
  return chosen;
}

/**
 * Whether today is a catch-up day: an earlier sitting ran in catch-up (DayRecord.catchUp), or the governor would plan
 * catch-up now. A micro, welcome-back or make-up plan then shows no counts, like the catch-up plan itself.
 */
async function catchUpToday(ctx: PlanContext): Promise<boolean> {
  if (ctx.day.catchUp) return true;
  const warmCards = ctx.cards.filter((c) => isWarmupCandidate(ctx, c)).map((c) => toWarmupCard(ctx, c));
  const warmById = new Map(warmCards.map((w) => [w.id, w]));
  const yesterday = studyDays(ctx).at(-1) ?? null;
  const ordered = orderWarmup(warmCards, { yesterday, takenGroups: takenGroups(ctx), catchUp: false, seed: ctx.today });
  return govern(await governorInput(ctx, govDue(ctx, ordered.order, warmById), false)).mode === 'catch-up';
}

/** A short plan (micro, welcome-back, make-up): no counts on a catch-up day (see catchUpToday). */
async function emptyPlan(ctx: PlanContext, mode: DayMode, warmup: string[], seconds: number): Promise<DayPlan> {
  const catchUp = await catchUpToday(ctx);
  return {
    day: ctx.today,
    courseDay: ctx.snapshot.courseDay,
    mode,
    sitting: 'any',
    budgetMin: ctx.settings.dailyMinutes,
    estimateMin: Math.ceil(seconds / 60),
    partOfDayDone: ctx.day.reviewMs + ctx.day.strandMs > 0 || totalNewSec(ctx.day.newSec) > 0,
    tomorrowMin: 0,
    strandMin: 0,
    warmup,
    bury: [],
    teach: [],
    pendingCheck: [],
    read: null,
    output: null,
    fluency: null,
    doneSteps: [...ctx.day.steps],
    ...(catchUp ? {} : { counts: { reviews: warmup.length, newItems: 0 } }),
    brake: false,
    offerExtraKanji: false,
    paperAllowed: false,
    courseComplete: courseComplete(ctx.snapshot),
  };
}

function secondsOf(ctx: PlanContext, ids: readonly string[]): number {
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  return ids.reduce((s, id) => {
    const card = byId.get(id)!;
    return s + cardSeconds({ key: timingKeyOf(card.kind, card.type), r: retrievability(card, ctx.now) }, ctx.seconds);
  }, 0);
}

/**
 * 3-minute plan, only when the learner asks (Today's micro link or the welcome-back offer): most overdue (lowest r)
 * non-write cards, truncated to 180 s; no new items, no reading, no output.
 */
export async function planMicro(now: Date = new Date(), opts: { welcomeBack?: boolean } = {}): Promise<DayPlan> {
  const ctx = await planContext(now);
  const cards = ctx.cards.filter((c) => isWarmupCandidate(ctx, c) && c.type !== 'write');
  const warmup = pickByRetrievability(ctx, cards, MICRO_SECONDS);
  const plan = await emptyPlan(ctx, opts.welcomeBack ? 'welcome-back' : 'micro', warmup, secondsOf(ctx, warmup));
  plan.tomorrowMin = await tomorrowMinutes(ctx, { warmup: new Set(warmup), newItems: [] });
  return plan;
}

/**
 * Make-up session for a streak repair (§3.1.11), offered once today's goal is met: review-ahead of cards due before
 * the next rollover + 24 h (lowest r first, siblings and today's items excluded), then sentence reading (resting rule
 * ignored) and, when eligible, a speed round. About 600 s; graded answers carry `makeup: true`.
 */
export async function planMakeup(now: Date = new Date()): Promise<DayPlan> {
  const ctx = await planContext(now);
  const ahead = nextStudyDayStart(now).getTime() + DAY_MS;
  const cards = ctx.cards.filter(
    (c) => !c.suspended && c.state !== State.New && c.due.getTime() <= ahead && introducedDay(ctx, c.itemId) !== ctx.today,
  );
  const warmup = pickByRetrievability(ctx, cards, MAKEUP_REVIEW_SECONDS);
  const [sentences, readCtx, speed] = await Promise.all([loadSentences(), iPlusOneContext(now, { ignoreResting: true }), speedRoundCards(now)]);
  const picks = pickIPlusOne(sentences, readCtx, MAKEUP_SENTENCES);
  const plan = await emptyPlan(ctx, 'makeup', warmup, MAKEUP_SECONDS);
  plan.paperAllowed = true;
  plan.read = picks.length ? { kind: 'sentences', kanaWords: [], sentences: picks.map((p) => ({ id: p.id, target: p.target })), minutes: picks.length } : null;
  plan.fluency = speed.length >= SPEED_ROUND_MIN_CARDS ? { kind: 'speed', cardIds: speed } : null;
  plan.tomorrowMin = await tomorrowMinutes(ctx, { warmup: new Set(warmup), newItems: [] });
  return plan;
}

/** Records a once-a-day step in DayRecord.steps (set-add; a second call is a no-op). */
export async function finishStep(step: DailyStepId, now: Date = new Date()): Promise<void> {
  await updateDay(dayKey(now), (d) => {
    if (!d.steps.includes(step)) d.steps.push(step);
  });
}

// ---------------------------------------------------------------------------
// Leak guard
// ---------------------------------------------------------------------------

export interface LeakMask {
  /**
   * Item ids whose reading must not be shown (their read or produce card is due today, unanswered: a produce card's
   * answer is the word's kana).
   */
  readings: Set<string>;
  /** Item ids whose meaning must not be shown (listen/meaning/comprehend due, unanswered). */
  meanings: Set<string>;
  /** Kanji whose written form must not be shown (write card due, unanswered). */
  kanji: Set<string>;
}

/** Cards due before the next 4 a.m. rollover and not reviewed today. */
export async function leakMask(now: Date = new Date()): Promise<LeakMask> {
  const today = dayKey(now);
  const until = nextStudyDayStart(now);
  const [due, logs] = await Promise.all([
    db.cards.where('due').below(until).toArray().then((cards) => cards.filter((c) => !c.suspended)),
    db.reviewLogs.where('reviewedAt').aboveOrEqual(studyDayLookback(now)).toArray(),
  ]);
  const answered = new Set(logs.filter((l) => dayKey(l.reviewedAt) === today).map((l) => l.cardId));
  const mask: LeakMask = { readings: new Set(), meanings: new Set(), kanji: new Set() };
  for (const card of due) {
    if (answered.has(card.id)) continue;
    if (card.type === 'read' || card.type === 'produce') mask.readings.add(card.itemId);
    else if (card.type === 'listen' || card.type === 'meaning' || card.type === 'comprehend') mask.meanings.add(card.itemId);
    else if (card.type === 'write' && card.kind === 'kanji') mask.kanji.add(card.itemId.slice('kanji:'.length));
  }
  return mask;
}

