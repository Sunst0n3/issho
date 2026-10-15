// The together engine: partner-quiz pools from this phone's own cards, applying
// a partner's verdicts to FSRS (idempotently, only near the due date), and the
// weekly plan of together sessions. It never imports src/sync or components:
// callers pass the server state and the partner's progress in.

import { State } from 'ts-fsrs';
import type {
  MemberProgress,
  PartnerQuizItem,
  PartnerQuizKind,
  Quiz,
  QuizItemVerdict,
  TogetherState,
  WeeklyCheckin,
} from '../../shared/api.ts';
import { dayKey, db, getSettings } from '../lib/db.ts';
import {
  loadCoreWords,
  loadGrammar,
  loadGrammarIndex,
  loadKanji,
  loadRolePlays,
  loadStories,
  loadUnits,
  loadWordInfo,
  type WordInfo,
} from '../lib/data.ts';
import { isKanji } from '../lib/ruby.ts';
import type {
  CardRecord,
  GrammarPoint,
  KanjiEntry,
  RolePlay,
  StoryEntry,
  StoryLevel,
  TargetRef,
  TogetherSlot,
  TogetherWeekPlan,
  UnitSpec,
} from '../lib/types.ts';
import { addDays, daysBetween, getDay, weekStart } from './days.ts';
import { logEncounters } from './encounters.ts';
import { firstStudyDay } from './habits.ts';
import { memberProgress } from './memberProgress.ts';
import { seasonFinaleDue } from './milestones.ts';
import { gradeCard, inPartnerWindow, PARTNER_GRADE, retrievability } from './scheduler.ts';

export const QUIZ_MAX = 10;
export const MONTHLY_QUIZ_MAX = 20;
export const DICTATION_WORDS = 5;
/** Days since introduction. */
export const QUIZ_AGE = [2, 10] as const;
/** Task targets, dictation, teach-me. */
export const RECENT_AGE = [2, 21] as const;
export const QUIZ_LAPSE_DAYS = 7;
const KEY_MAX = 80;
const TEXT_MAX = 200;

const QUIZ_KIND: Partial<Record<CardRecord['type'], PartnerQuizKind>> = { write: 'write', read: 'read', produce: 'produce', build: 'build' };
const KIND_ROTATION: readonly PartnerQuizKind[] = ['write', 'read', 'produce', 'build'];

const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

/** The word with its kanji blanked: '日本', '日' → '□本'. */
function blanked(written: string, char: string): string {
  return written.split(char).join('□');
}

/** Ruby for a word: '{日本|にほん}', or the kana for a kana-only word. */
function wordRuby(w: WordInfo): string {
  return [...w.written].some(isKanji) ? `{${w.written}|${w.kana}}` : w.kana;
}

/**
 * pure: the asker's prompt/answer for one card (write: 'Write the kanji for "water" · □本 にほん' / '水';
 * read: written word / kana; produce: English + note / Japanese; build: English / jp).
 */
export function partnerPrompt(
  card: Pick<CardRecord, 'id' | 'itemId' | 'kind' | 'type'>,
  info: { kanji?: KanjiEntry; word?: WordInfo; grammar?: GrammarPoint; anchor?: WordInfo },
): PartnerQuizItem {
  const kind = QUIZ_KIND[card.type] ?? 'read';
  const key = card.id.slice(0, KEY_MAX);
  switch (kind) {
    case 'write': {
      const char = card.itemId.slice(card.itemId.indexOf(':') + 1);
      const keyword = info.kanji?.meanings[0] ?? char;
      const anchor = info.anchor ? ` · ${blanked(info.anchor.written, char)} ${info.anchor.kana}` : '';
      return { key, kind, prompt: clip(`Write the kanji for "${keyword}"${anchor}`), answer: char };
    }
    case 'read': {
      const w = info.word;
      return { key, kind, prompt: clip(w?.written ?? card.itemId), answer: clip(w?.kana ?? '') };
    }
    case 'produce': {
      const w = info.word;
      const note = w?.note ? ` (${w.note})` : '';
      return { key, kind, prompt: clip(`${w?.en ?? ''}${note}`), answer: clip(w ? wordRuby(w) : '') };
    }
    case 'build': {
      const item = info.grammar?.buildItems[0];
      return { key, kind, prompt: clip(item?.en ?? info.grammar?.title ?? ''), answer: clip(item?.jp ?? info.grammar?.pattern ?? '') };
    }
  }
}

interface PoolContext {
  kanji: Record<string, KanjiEntry>;
  word: (ref: string) => WordInfo | undefined;
  grammar: Map<string, GrammarPoint>;
  anchorOf: (char: string) => WordInfo | undefined;
}

async function poolContext(): Promise<PoolContext> {
  const [kanji, word, grammar, items] = await Promise.all([loadKanji(), loadWordInfo(), loadGrammarIndex(), db.items.toArray()]);
  // The anchor a kanji was taught with: the first word item of that kanji introduced with it (same day), else any.
  const words = items.filter((i) => i.kind === 'word' || i.kind === 'core').sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime());
  const kanjiDay = new Map(items.filter((i) => i.kind === 'kanji').map((i) => [i.key, dayKey(i.introducedAt)]));
  const anchorOf = (char: string) => {
    const day = kanjiDay.get(char);
    const withChar = words.filter((w) => word(w.id)?.kanji.includes(char));
    const pick = withChar.find((w) => dayKey(w.introducedAt) === day) ?? withChar[0];
    return pick ? word(pick.id) : undefined;
  };
  return { kanji, word, grammar, anchorOf };
}

function promptFor(card: CardRecord, ctx: PoolContext): PartnerQuizItem {
  const key = card.itemId.slice(card.itemId.indexOf(':') + 1);
  return partnerPrompt(card, {
    kanji: card.kind === 'kanji' ? ctx.kanji[key] : undefined,
    word: card.kind === 'word' || card.kind === 'core' ? ctx.word(card.itemId) : undefined,
    grammar: card.kind === 'grammar' ? ctx.grammar.get(key) : undefined,
    anchor: card.kind === 'kanji' ? ctx.anchorOf(key) : undefined,
  });
}

/** Cards a partner can quiz: kanji write, word/core read and produce, grammar build. */
function quizzable(card: CardRecord): boolean {
  if (card.suspended || card.state === State.New || !QUIZ_KIND[card.type]) return false;
  if (card.type === 'write') return card.kind === 'kanji';
  if (card.type === 'build') return card.kind === 'grammar';
  return card.kind === 'word' || card.kind === 'core';
}

/** Round-robin over the kinds (write → read → produce → build), each kind in its own order. */
function roundRobin(cards: readonly CardRecord[], max: number): CardRecord[] {
  const buckets = new Map<PartnerQuizKind, CardRecord[]>(KIND_ROTATION.map((k) => [k, []]));
  for (const card of cards) buckets.get(QUIZ_KIND[card.type]!)!.push(card);
  const out: CardRecord[] = [];
  while (out.length < max && [...buckets.values()].some((b) => b.length)) {
    for (const kind of KIND_ROTATION) {
      const next = buckets.get(kind)!.shift();
      if (next && out.length < max) out.push(next);
    }
  }
  return out;
}

/**
 * This phone's answerer pool (the learner's own cards).
 * partner: cards of items introduced 2–10 days ago plus cards with an Again in the last 7 days, never items introduced
 * today, lapses first then oldest, kinds mixed round-robin (write → read → produce → build), max 10.
 * monthly: non-suspended Review cards, lowest retrievability first, max 20.
 * dictation: up to 5 kanji introduced 2–21 days ago that have an anchor word and a non-retired write card, lowest write
 * stability first. Item key = the kanji's write card ('kanji:水|write'), kind 'write'; prompt = the anchor's kana plus
 * its English (the asker reads the kana aloud); answer = the anchor written ('水').
 */
export async function buildQuizPool(kind: 'partner' | 'monthly' | 'dictation', now: Date = new Date()): Promise<PartnerQuizItem[]> {
  const today = dayKey(now);
  const [ctx, items, cards] = await Promise.all([poolContext(), db.items.toArray(), db.cards.toArray()]);
  const introduced = new Map(items.map((i) => [i.id, dayKey(i.introducedAt)]));
  const age = (itemId: string) => {
    const day = introduced.get(itemId);
    return day === undefined ? -1 : daysBetween(day, today);
  };

  if (kind === 'monthly') {
    return cards
      .filter((c) => quizzable(c) && c.state === State.Review)
      .map((c) => ({ c, r: retrievability(c, now) }))
      .sort((a, b) => a.r - b.r || a.c.id.localeCompare(b.c.id))
      .slice(0, MONTHLY_QUIZ_MAX)
      .map(({ c }) => promptFor(c, ctx));
  }

  if (kind === 'dictation') {
    const out: { item: PartnerQuizItem; stability: number }[] = [];
    for (const card of cards) {
      if (card.kind !== 'kanji' || card.type !== 'write' || card.suspended || card.state === State.New) continue;
      const a = age(card.itemId);
      if (a < RECENT_AGE[0] || a > RECENT_AGE[1]) continue;
      const char = card.itemId.slice('kanji:'.length);
      const anchor = ctx.anchorOf(char);
      if (!anchor) continue;
      out.push({
        item: { key: card.id.slice(0, KEY_MAX), kind: 'write', prompt: clip(`${anchor.kana} · ${anchor.en}`), answer: clip(anchor.written) },
        stability: card.stability,
      });
    }
    return out.sort((a, b) => a.stability - b.stability).slice(0, DICTATION_WORDS).map((o) => o.item);
  }

  const since = new Date(now.getTime() - QUIZ_LAPSE_DAYS * 24 * 60 * 60 * 1000);
  const lapsed = new Map<string, number>();
  for (const log of await db.reviewLogs.where('reviewedAt').between(since, now, true, true).toArray()) {
    if (log.grade === 1) lapsed.set(log.cardId, Math.max(lapsed.get(log.cardId) ?? 0, log.reviewedAt.getTime()));
  }
  const pool = cards.filter((c) => {
    if (!quizzable(c)) return false;
    const a = age(c.itemId);
    if (a <= 0) return false;
    return (a >= QUIZ_AGE[0] && a <= QUIZ_AGE[1]) || lapsed.has(c.id);
  });
  pool.sort((a, b) => {
    const la = lapsed.has(a.id) ? 0 : 1;
    const lb = lapsed.has(b.id) ? 0 : 1;
    return la - lb || (introduced.get(a.itemId) ?? '').localeCompare(introduced.get(b.itemId) ?? '') || a.id.localeCompare(b.id);
  });
  return roundRobin(pool, QUIZ_MAX).map((c) => promptFor(c, ctx));
}

async function applyVerdicts(
  quizId: string,
  createdAt: Date,
  verdicts: readonly QuizItemVerdict[],
  now: Date,
): Promise<{ graded: number; practiced: number }> {
  return db.transaction('rw', [db.partnerQuizzes, db.cards, db.reviewLogs, db.days, db.encounters, db.settings, db.items], async () => {
    const existing = await db.partnerQuizzes.get(quizId);
    if (existing?.appliedAt) return { graded: existing.graded, practiced: existing.practiced };
    let graded = 0;
    let practiced = 0;
    for (const v of verdicts) {
      const card = await db.cards.get(v.key);
      if (!card) continue;
      if (inPartnerWindow(card, now)) {
        await gradeCard(card.id, PARTNER_GRADE[v.verdict], { durationMs: 0, mode: 'partner', context: 'partner', now });
        graded++;
      } else {
        await logEncounters([card.itemId], 'partner', now);
        practiced++;
      }
    }
    await db.partnerQuizzes.put({ quizId, role: 'answerer', createdAt: existing?.createdAt ?? createdAt, appliedAt: now, graded, practiced });
    return { graded, practiced };
  });
}

/**
 * Answerer side, for kinds partner, dictation and monthly. One rw transaction over [partnerQuizzes, cards, reviewLogs,
 * days, encounters, settings, items]: if partnerQuizzes[quiz.id].appliedAt is set, return the stored counts and change
 * nothing; else each verdict whose key is one of this phone's cards → gradeCard(mode 'partner', context 'partner',
 * PARTNER_GRADE) when inPartnerWindow(card, now), else logEncounters(…, 'partner'); then set appliedAt. A quiz arriving
 * twice (the 'quiz' WS event and a refresh, or two tabs) is applied once.
 */
export async function applyPartnerVerdicts(quiz: Quiz, now: Date = new Date()): Promise<{ graded: number; practiced: number }> {
  if (quiz.kind === 'kanji' || !quiz.result?.verdicts) return { graded: 0, practiced: 0 };
  const created = new Date(quiz.createdAt);
  return applyVerdicts(quiz.id, Number.isNaN(created.getTime()) ? now : created, quiz.result.verdicts, now);
}

/** Pass-and-play: verdicts for the device owner's pool applied at once (same transaction rule, keyed by a local quiz id). */
export async function applyLocalVerdicts(
  quizId: string,
  items: readonly PartnerQuizItem[],
  verdicts: readonly QuizItemVerdict[],
  now: Date = new Date(),
): Promise<{ graded: number; practiced: number }> {
  const keys = new Set(items.map((i) => i.key));
  return applyVerdicts(quizId, now, verdicts.filter((v) => keys.has(v.key)), now);
}

/** A kanji introduced 2–21 days ago with the lowest write stability, for the teach-me turn. */
export async function teachMeKanji(now: Date = new Date()): Promise<string | null> {
  const today = dayKey(now);
  const items = await db.items.where('kind').equals('kanji').toArray();
  const recent = items.filter((i) => {
    const age = daysBetween(dayKey(i.introducedAt), today);
    return age >= RECENT_AGE[0] && age <= RECENT_AGE[1];
  });
  if (!recent.length) return null;
  const cards = await db.cards.bulkGet(recent.map((i) => `${i.id}|write`));
  const ranked = recent
    .map((item, i) => ({ char: item.key, stability: cards[i]?.stability ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.stability - b.stability || a.char.localeCompare(b.char));
  return ranked[0].char;
}

/** pure: the couple's settled unit: min(mine, partner ?? mine) of MemberProgress.settledUnit. */
export function coupleSettledUnit(mine: number, partner?: number): number {
  return Math.min(mine, partner ?? mine);
}

export const TASK_TARGETS_MIN = 5;
export const TASK_TARGETS_MAX = 8;

/**
 * pure: 5–8 task-card targets (item ids). First the authored targets that either partner introduced 2–21 days ago, then
 * topped up alternately from my recent items and the partner's recentItems (both 2–21 days old, so never today's
 * items), no duplicates, max 8. Fewer than 5 only when both lists run out.
 */
export function taskTargets(authored: readonly TargetRef[], mineRecent: readonly string[], partnerRecent: readonly string[]): string[] {
  const recent = new Set([...mineRecent, ...partnerRecent]);
  const out: string[] = [];
  const add = (id: string) => {
    if (out.length < TASK_TARGETS_MAX && !out.includes(id)) out.push(id);
  };
  for (const t of authored) if (recent.has(t)) add(t);
  for (let i = 0; out.length < TASK_TARGETS_MAX && (i < mineRecent.length || i < partnerRecent.length); i++) {
    if (i < mineRecent.length) add(mineRecent[i]);
    if (i < partnerRecent.length) add(partnerRecent[i]);
  }
  return out;
}

export interface WeekPlanInput {
  week: string;
  slots: readonly TogetherSlot[];
  state: TogetherState | null;
  units: readonly UnitSpec[];
  roleplays: readonly RolePlay[];
  stories: readonly StoryEntry[];
  me: { settledUnit: number; readyStories: readonly string[]; coreReached: number; grammarReached: number };
  partner?: { settledUnit: number; readyStories: readonly string[]; coreReached: number; grammarReached: number };
  /** Story ids already used as a shared story. */
  usedShared: ReadonlySet<string>;
  /** seasonFinaleDue(...) is not null on this phone. */
  seasonFinale: boolean;
  /** CoreWord.order by id (eligibleRolePlays); without it the order is read from 'cw-NNNN'. */
  coreOrder?: ReadonlyMap<string, number>;
  /** GrammarPoint.order by id (eligibleRolePlays: grammarReached is an order); without it, the position in the units'
   *  grammar lists. */
  grammarOrder?: ReadonlyMap<string, number>;
}

const LEVEL_RANK: Record<StoryLevel, number> = { start: 0, L0: 1, L1: 2 };
const DEFAULT_MONTHLY_TIME = '10:00';
/** A task's repeat (with its twist) comes back after at least this many days, ideally within 7. */
export const TASK_REPEAT_AFTER = 2;

/** The Saturday of `week` when it is the first Saturday of its month. */
function firstSaturdayIn(week: string): string | null {
  const saturday = addDays(week, 5);
  return Number(saturday.slice(8, 10)) <= 7 ? saturday : null;
}

/**
 * pure: free role-plays (not core conversations) with unit ≤ settledUnit + 1, or without a unit, and ≤ 2 targets that
 * are not introduced for **both** partners (core targets by `order ≤ coreReached`, grammar by `order ≤ grammarReached`,
 * min over the two partners).
 */
export function eligibleRolePlays(
  scripts: readonly RolePlay[],
  coreConversationIds: ReadonlySet<string>,
  introducedForBoth: (t: TargetRef) => boolean,
  settledUnit: number,
): RolePlay[] {
  return scripts.filter(
    (s) =>
      !coreConversationIds.has(s.id) &&
      (s.unit === undefined || s.unit <= settledUnit + 1) &&
      s.targets.filter((t) => !introducedForBoth(t)).length <= 2,
  );
}

/** pure: "introduced for both partners" from the orders each partner reached. */
function introducedForBothFrom(input: WeekPlanInput): (t: TargetRef) => boolean {
  const coreReached = Math.min(input.me.coreReached, input.partner?.coreReached ?? input.me.coreReached);
  const grammarReached = Math.min(input.me.grammarReached, input.partner?.grammarReached ?? input.me.grammarReached);
  const grammarOrder = input.grammarOrder ?? new Map(input.units.flatMap((u) => u.grammar).map((id, i) => [id, i + 1]));
  return (t) => {
    if (t.startsWith('core:')) {
      const id = t.slice(5);
      const order = input.coreOrder?.get(id) ?? Number(/^cw-(\d+)$/.exec(id)?.[1] ?? Number.POSITIVE_INFINITY);
      return order <= coreReached;
    }
    const order = grammarOrder.get(t.slice('grammar:'.length));
    return order !== undefined && order <= grammarReached;
  };
}

/**
 * pure.
 *  Sessions: one per slot on its weekday this week, plus { id: 'monthly', day: the month's first Saturday, time: the C
 *  slot's time or '10:00' } when that Saturday is in this week.
 *  settledUnit = coupleSettledUnit(me, partner).
 *  Conversation: the script named by the lowest unit ≤ settledUnit + 1 whose stage < 5 (missing = 1); its stage is
 *  capped at 1 (listen and shadow) when that unit > settledUnit, because S2–S4 need the unit's grammar.
 *  Task: only from units ≤ settledUnit: the settled unit's task if not run; else its repeat (twist) once the first run is
 *  ≥ 2 days old (and ≤ 7 when possible); else the newest earlier unit's task not run. With no task (no settled unit
 *  yet, every task run, or the task not `ready`): rolePlayId = the first eligibleRolePlays script, else the core
 *  conversation of unit settledUnit + 1; run at stage 1.
 *  storyId: first story by level/unit/id in both partners' readyStories and not in usedShared.
 *  capstoneUnit (monthly weeks only): the highest unit ≤ settledUnit whose capstone isn't done.
 *  showcase = seasonFinale.
 */
export function buildWeekPlan(input: WeekPlanInput): TogetherWeekPlan {
  const { week, state } = input;
  const units = [...input.units].sort((a, b) => a.id - b.id);
  const settledUnit = coupleSettledUnit(input.me.settledUnit, input.partner?.settledUnit);
  const scriptIds = new Set(input.roleplays.map((r) => r.id));

  const done = (session: string) => state?.sessions.find((s) => s.week === week && s.session === session);
  const sessions: TogetherWeekPlan['sessions'] = [...input.slots]
    .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time))
    .map((slot) => {
      const run = done(slot.session);
      return { id: slot.session, day: addDays(week, slot.weekday - 1), time: slot.time, ...(run ? { doneAt: run.date, minutes: run.minutes } : {}) };
    });
  const saturday = firstSaturdayIn(week);
  if (saturday) {
    const run = done('monthly');
    const time = input.slots.find((s) => s.session === 'C')?.time ?? DEFAULT_MONTHLY_TIME;
    sessions.push({ id: 'monthly', day: saturday, time, ...(run ? { doneAt: run.date, minutes: run.minutes } : {}) });
  }

  // Session A: the lowest unfinished core conversation within reach.
  const stageOf = (scriptId: string) => state?.stages[scriptId] ?? 1;
  let conversation: TogetherWeekPlan['conversation'];
  for (const unit of units) {
    if (unit.id > settledUnit + 1) break;
    if (!scriptIds.has(unit.conversation) || stageOf(unit.conversation) >= 5) continue;
    const stage = Math.max(1, Math.min(4, stageOf(unit.conversation)));
    conversation = { scriptId: unit.conversation, stage: (unit.id > settledUnit ? 1 : stage) as 1 | 2 | 3 | 4 };
    break;
  }

  // Session B: a task of a settled unit, its repeat, an earlier unit's task, else a free role-play.
  const runs = (taskId: string, repeat: boolean) => (state?.tasks ?? []).filter((t) => t.taskId === taskId && t.repeat === repeat);
  const bDay = sessions.find((s) => s.id === 'B')?.day ?? week;
  let task: TogetherWeekPlan['task'];
  const settled = units.find((u) => u.id === settledUnit);
  if (settled?.task.ready) {
    const first = runs(settled.task.id, false).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!first) task = { unit: settled.id, taskId: settled.task.id, repeat: false };
    else if (!runs(settled.task.id, true).length && daysBetween(first.date, bDay) >= TASK_REPEAT_AFTER) {
      task = { unit: settled.id, taskId: settled.task.id, repeat: true };
    }
  }
  if (!task) {
    const earlier = units.filter((u) => u.id < settledUnit && u.task.ready && !runs(u.task.id, false).length).at(-1);
    if (earlier) task = { unit: earlier.id, taskId: earlier.task.id, repeat: false };
  }
  let rolePlayId: string | undefined;
  if (!task) {
    const coreConversations = new Set(units.map((u) => u.conversation));
    const free = eligibleRolePlays(input.roleplays, coreConversations, introducedForBothFrom(input), settledUnit)[0];
    const next = units.find((u) => u.id === settledUnit + 1)?.conversation;
    rolePlayId = free?.id ?? (next && scriptIds.has(next) ? next : undefined);
  }

  // Session C: the shared story, first ready for both.
  const ready = new Set(input.me.readyStories);
  const partnerReady = new Set(input.partner?.readyStories ?? input.me.readyStories);
  const story = [...input.stories]
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.unit - b.unit || a.id.localeCompare(b.id))
    .find((s) => ready.has(s.id) && partnerReady.has(s.id) && !input.usedShared.has(s.id));

  const monthly = saturday !== null;
  const capstonesDone = new Set((state?.capstones ?? []).map((c) => c.unit));
  const capstoneUnit = monthly ? units.filter((u) => u.id <= settledUnit && !capstonesDone.has(u.id)).at(-1)?.id : undefined;

  return {
    week,
    sessions,
    settledUnit,
    ...(conversation ? { conversation } : {}),
    ...(task ? { task } : {}),
    ...(rolePlayId ? { rolePlayId } : {}),
    ...(story ? { storyId: story.id } : {}),
    monthly,
    ...(capstoneUnit !== undefined ? { capstoneUnit } : {}),
    showcase: input.seasonFinale,
  };
}

/**
 * Assembles WeekPlanInput from local data plus the caller's `state` (F's useTogetherState) and `partner` (the household's
 * MemberProgress, through E), and caches it in togetherPlans.
 */
export async function loadWeekPlan(input: { state: TogetherState | null; partner?: MemberProgress }, now: Date = new Date()): Promise<TogetherWeekPlan> {
  const today = dayKey(now);
  const week = weekStart(today);
  const [settings, units, roleplays, stories, core, grammar, me, storyRows, oldPlans, firstDay, milestones] = await Promise.all([
    getSettings(),
    loadUnits(),
    loadRolePlays(),
    loadStories(),
    loadCoreWords(),
    loadGrammar(),
    memberProgress(now),
    db.stories.toArray(),
    db.togetherPlans.where('week').below(week).toArray(),
    firstStudyDay(now),
    db.milestones.toArray(),
  ]);
  const usedShared = new Set<string>([
    ...storyRows.filter((s) => s.sharedWeek !== undefined && s.sharedWeek < week).map((s) => s.storyId),
    ...oldPlans.map((p) => p.plan.storyId).filter((id): id is string => id !== undefined),
  ]);
  const seen = new Set(milestones.filter((m) => m.seenAt).map((m) => m.id));
  const slots = input.state?.slots.length ? input.state.slots : settings.togetherSlots;
  const pick = (p: MemberProgress) => ({
    settledUnit: p.settledUnit,
    readyStories: p.readyStories,
    coreReached: p.coreReached,
    grammarReached: p.grammarReached,
  });
  const plan = buildWeekPlan({
    week,
    slots,
    state: input.state,
    units,
    roleplays,
    stories,
    me: pick(me),
    ...(input.partner ? { partner: pick(input.partner) } : {}),
    usedShared,
    seasonFinale: seasonFinaleDue(firstDay, today, seen) !== null,
    coreOrder: new Map(core.map((w) => [w.id, w.order])),
    grammarOrder: new Map(grammar.map((g) => [g.id, g.order])),
  });
  await db.togetherPlans.put({ week, plan, updatedAt: now });
  return plan;
}

/** The week's counts for the check-in: items introduced and minutes studied (solo + together) Monday → today. */
export async function weeklyCheckinCounts(week: string, now: Date = new Date()): Promise<WeeklyCheckin['counts']> {
  const today = dayKey(now);
  const end = addDays(week, 6) < today ? addDays(week, 6) : today;
  const items = await db.items.toArray();
  const counts = { kanji: 0, words: 0, grammar: 0, minutes: 0 };
  for (const item of items) {
    const day = dayKey(item.introducedAt);
    if (day < week || day > end || item.via === 'placement') continue;
    if (item.kind === 'kanji') counts.kanji++;
    else if (item.kind === 'word' || item.kind === 'core') counts.words++;
    else if (item.kind === 'grammar') counts.grammar++;
  }
  let ms = 0;
  for (let d = week; d <= end; d = addDays(d, 1)) {
    const day = await getDay(d);
    ms += day.studyMs + day.togetherMs;
  }
  counts.minutes = Math.round(ms / 60_000);
  return counts;
}
