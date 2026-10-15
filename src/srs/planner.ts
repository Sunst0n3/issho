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
  DailyMinutes,
  DailyStepId,
  DayRecord,
  FluencyKind,
  ItemRecord,
  KanaRule,
  OutputTarget,
  ReviewLogRecord,
  Settings,
  WordRef,
} from '../lib/types.ts';
import { loadCourseSnapshot, streamCandidates, taughtKanaFrom, type CourseSnapshot, type NewItemPlan } from './course.ts';
import { addDays, DAY_MS, dayStart, getDay, normalizeDay, studyDayLookback, totalNewSec, updateDay, weekStart } from './days.ts';
import { pickFluency, speedRoundCards, SPEED_ROUND_MIN_CARDS } from './fluency.ts';
import {
  cardSeconds,
  govern,
  HARD_CAP_FACTOR,
  PRICE_SEC,
  strandMinutes,
  type GovDueCard,
  type GovernorInput,
  type GovernorOutput,
  type SharedStream,
} from './governor.ts';
import { syncWriteRetirement } from './items.ts';
import type { NumberDrillItem } from './numbersDrill.ts';
import { pickOutputTarget } from './output.ts';
import type { PitchItem } from './pitch.ts';
import { iPlusOneContext, pickIPlusOne, pickRead } from './readListen.ts';
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
   *  with its clip ref ('kanaEx:<c>' or 'kanaRule:<id>#<n>'). kana-check: KanaRule.checkWords (refs 'core:<id>'). */
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
  /** "About N min (left) today": ceil(GovernorOutput.seconds.total / 60), without the unused strand reserve once no
   *  read, output or fluency step is left (an anywhere sitting: its warm-up only). */
  estimateMin: number;
  /** An earlier sitting already did something today: the UI says "left today". */
  partOfDayDone: boolean;
  /** "tomorrow about M": cards due by tomorrow's rollover + 7-day mean new seconds + R. */
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
      staged: Math.round(day.newSec.staged / PRICE_SEC.staged),
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

/** Review seconds a new item's cards will cost tomorrow. */
function newItemReviewSeconds(item: NewItemPlan, sec: Record<TimingKey, number>): number {
  switch (item.kind) {
    case 'kana':
      return sec.kanaRead + sec.kanaWrite;
    case 'kanaRule':
      return sec.kanaRead;
    case 'kanji':
      return sec.kanjiWrite + (item.anchor ? sec.wordRead : sec.kanjiMeaning);
    case 'core':
      return sec.listen + sec.produce;
    case 'grammar':
      return sec.comprehend + sec.build;
    case 'staged':
      return sec.wordRead;
  }
}

async function tomorrowMinutes(ctx: PlanContext, warmup: ReadonlySet<string>, teach: readonly NewItemPlan[], pending: readonly string[]): Promise<number> {
  const end = nextStudyDayStart(ctx.now).getTime() + DAY_MS;
  let seconds = 0;
  for (const card of ctx.cards) {
    if (card.suspended || warmup.has(card.id)) continue;
    const key = timingKeyOf(card.kind, card.type);
    if (card.state === State.New) {
      if (pending.includes(card.id)) seconds += ctx.seconds[key];
      continue;
    }
    if (card.due.getTime() <= end) seconds += ctx.seconds[key];
  }
  for (const item of teach) seconds += newItemReviewSeconds(item, ctx.seconds);
  const week = await daysBefore(ctx, 7);
  seconds += week.reduce((s, d) => s + totalNewSec(d.newSec), 0) / 7;
  const budget = ctx.settings.dailyMinutes;
  seconds += 60 * strandMinutes(ctx.snapshot.courseDay + 1, [...ctx.items.values()].filter((i) => i.kind === 'word' || i.kind === 'core').length, budget);
  return Math.min(Math.ceil(seconds / 60), Math.ceil(HARD_CAP_FACTOR * budget));
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
  // Examples that use today's kana first, then any other readable example.
  const candidates = Object.entries(examples).filter(([, ex]) => readableWith(ex.kana, taught));
  const usesToday = (kana: string) => kanaUnits(kana).some((u) => todayKana.includes(u));
  for (const [char, ex] of [...candidates.filter(([, ex]) => usesToday(ex.kana)), ...candidates.filter(([, ex]) => !usesToday(ex.kana))]) {
    if (words.length >= lessons * KANA_WORDS_PER_LESSON) break;
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
  let ordered = orderWarmup(warmCards, { yesterday, takenGroups: taken, catchUp: false });
  const input = await governorInput(ctx, govDue(ctx, ordered.order, warmById), opts.extraKanji ?? false);
  let gov: GovernorOutput = govern(input);
  if (gov.mode === 'catch-up') {
    ordered = orderWarmup(warmCards, { yesterday, takenGroups: taken, catchUp: true });
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
      read = picked.story || picked.sentences.length ? picked : null;
    }
  }

  const warmup = gov.reviews;
  // The unused strand reserve is time left today only while a read, output or fluency step is still planned:
  // once they are done (or there is nothing to read), "About N min left" must not count it.
  const strandLeft = read || output || fluency ? gov.seconds.strands : 0;
  const total = anywhere ? gov.seconds.reviews : gov.seconds.total - gov.seconds.strands + strandLeft;
  return {
    day: today,
    courseDay: snapshot.courseDay,
    mode,
    sitting,
    budgetMin: settings.dailyMinutes,
    estimateMin: Math.ceil(total / 60),
    partOfDayDone: gov.seconds.doneToday > 0,
    tomorrowMin: await tomorrowMinutes(ctx, new Set(warmup), teachItems, pending),
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
 * second call changes nothing), syncWriteRetirement, DayRecord.catchUp = true when plan.mode is 'catch-up' (never reset
 * to false within the day), and Settings.freshStart cleared when plan.mode is 'normal' on or after that date.
 */
export async function startSitting(plan: DayPlan, now: Date = new Date()): Promise<void> {
  const until = nextStudyDayStart(now);
  const today = dayKey(now);
  await db.transaction('rw', db.cards, db.days, async () => {
    const cards = await db.cards.bulkGet(plan.bury);
    const moved = cards.filter((c): c is CardRecord => c !== undefined && c.due.getTime() < until.getTime()).map((c) => ({ ...c, due: until }));
    if (moved.length) await db.cards.bulkPut(moved);
    if (plan.mode === 'catch-up') {
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

function emptyPlan(ctx: PlanContext, mode: DayMode, warmup: string[], seconds: number): DayPlan {
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
    counts: { reviews: warmup.length, newItems: 0 },
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
  const plan = emptyPlan(ctx, opts.welcomeBack ? 'welcome-back' : 'micro', warmup, secondsOf(ctx, warmup));
  plan.tomorrowMin = await tomorrowMinutes(ctx, new Set(warmup), [], []);
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
  const plan = emptyPlan(ctx, 'makeup', warmup, MAKEUP_SECONDS);
  plan.paperAllowed = true;
  plan.read = picks.length ? { kind: 'sentences', kanaWords: [], sentences: picks.map((p) => ({ id: p.id, target: p.target })), minutes: picks.length } : null;
  plan.fluency = speed.length >= SPEED_ROUND_MIN_CARDS ? { kind: 'speed', cardIds: speed } : null;
  plan.tomorrowMin = await tomorrowMinutes(ctx, new Set(warmup), [], []);
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
  /** Item ids whose reading must not be shown (their read card is due today, unanswered). */
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
    if (card.type === 'read') mask.readings.add(card.itemId);
    else if (card.type === 'listen' || card.type === 'meaning' || card.type === 'comprehend') mask.meanings.add(card.itemId);
    else if (card.type === 'write' && card.kind === 'kanji') mask.kanji.add(card.itemId.slice('kanji:'.length));
  }
  return mask;
}

