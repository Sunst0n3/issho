// Course simulator: a deterministic learner going through the real candidate,
// governor, warm-up and FSRS logic, one sitting a day. Used by simulate.test.ts
// to lock in the planned minutes and pace, and by devSeed to reach a course day
// with real ids.

import { Rating, State, type Grade } from 'ts-fsrs';
import { DEFAULT_WRITE_LIST, itemId } from '../lib/db.ts';
import { loadCoreWords, loadCurriculum, loadGrammar, loadKana, loadKanaRules, loadKanji, loadWordIndex } from '../lib/data.ts';
import type {
  CardRecord,
  CoreWord,
  Curriculum,
  CurriculumUnit,
  DailyMinutes,
  DayRecord,
  GrammarPoint,
  ItemKind,
  ItemRecord,
  KanaEntry,
  KanaRule,
  ReviewContext,
  ReviewLogRecord,
  StagedWordRecord,
  WordRef,
} from '../lib/types.ts';
import {
  buildSnapshot,
  componentMap,
  STAGED_RELEASE_DAYS,
  streamCandidates,
  type CourseData,
  type NewItemPlan,
  type StreamCandidates,
} from './course.ts';
import { addDays, DAY_MS, emptyDay, isStudyDay, totalNewSec } from './days.ts';
import { govern, type GovDueCard, type GovernorInput, type GovernorOutput, type SharedStream } from './governor.ts';
import { cardTypesFor, shouldRetire, type CardTypeContext } from './items.ts';
import { seededRandom } from './random.ts';
import { elapsedDaysOf, getScheduler, newCardRecord, nextCard, retrievability } from './scheduler.ts';
import { DEFAULT_SECONDS, timingKeyOf, type TimingKey } from './timing.ts';
import { orderWarmup, siblingGroups, type WarmupCard } from './warmup.ts';

/** The static course the simulator teaches: the real data, or a synthetic stand-in for fast tests. */
export interface SimCourse {
  kana: KanaEntry[];
  rules: KanaRule[];
  curriculum: Curriculum;
  core: CoreWord[];
  grammar: GrammarPoint[];
  /** WordEntry.use for JMdict refs (produce cards). */
  wordUse: (ref: WordRef) => boolean;
  /** Kanji of a JMdict ref (sibling groups); synthetic words use their own kanji. */
  wordKanji?: (ref: WordRef) => string[];
  /** Kanji → component kanji (CourseData.components); the synthetic course has none. */
  components?: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// Synthetic course
// ---------------------------------------------------------------------------

export const SYNTHETIC_KANJI = 2136;
export const SYNTHETIC_CORE = 1577;
export const SYNTHETIC_GRAMMAR = 115;
/** The 51 zero-word kanji, at fixed positions. */
const ZERO_WORD = new Set(Array.from({ length: 51 }, (_, k) => 20 + 42 * k));
/** Staged words per kanji, by index % 25: two 0s, four 1s, nineteen 2s → mean 1.68 (2.68 words with the anchor). */
const STAGED_PATTERN = [0, 1, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 0, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2];
/** Meaning set (numbers) members, by curriculum index. */
const NUMBER_UNITS = [0, 1, 2, 4, 6, 9, 13, 17, 22, 28];
/** Visual confusable pairs (index, index + 12). */
const VISUAL_PAIRS = [30, 70, 110, 150, 190, 230, 270, 310, 350];
/** Core orders 1–415 without a produce card (409 'use' words, as authored). */
const CORE_NO_USE = new Set([50, 120, 190, 260, 330, 400]);
/** Every 10th kanji (index % 10 = 5) has a core word as its anchor (one identity: merges and spelling upgrades). */
const coreAnchorOrder = (index: number) => 40 + index;
const RECOGNITION_ONLY = new Set([60, 80, 95, 110]);

const kanjiChar = (index: number) => String.fromCodePoint(0x4e00 + index);
const coreId = (order: number) => `cw-${String(order).padStart(4, '0')}`;
const wordRefOf = (index: number, slot: number): WordRef => `word:${1_000_000 + index * 3 + slot}`;

/**
 * pure: the real kana table and rules plus a synthetic curriculum of 2,136 kanji (51 zero-word at fixed positions,
 * the rest with an anchor and 0–2 staged words: mean 2.68 words per kanji), 1,577 core words (use = 409 words spread
 * over orders 1–415, as authored) and 115 grammar points (4 recognitionOnly, prerequisites in a chain).
 */
export function syntheticCourse(kana: readonly KanaEntry[], rules: readonly KanaRule[]): SimCourse {
  const coreKanji = new Map<number, string[]>();
  const units: CurriculumUnit[] = [];
  for (let index = 0; index < SYNTHETIC_KANJI; index++) {
    const char = kanjiChar(index);
    const zero = ZERO_WORD.has(index);
    let anchor: WordRef | null = zero ? null : wordRefOf(index, 0);
    if (!zero && index % 10 === 5 && coreAnchorOrder(index) <= SYNTHETIC_CORE) {
      anchor = `core:${coreId(coreAnchorOrder(index))}`;
      coreKanji.set(coreAnchorOrder(index), [char]);
    }
    const staged = zero ? [] : [wordRefOf(index, 1), wordRefOf(index, 2)].slice(0, STAGED_PATTERN[index % STAGED_PATTERN.length]);
    units.push({ index, char, anchor, staged, inferable: false, chapter: Math.floor(index / 15) + 1 });
  }
  const confusables = [
    { id: 'm-numbers', chars: NUMBER_UNITS.map(kanjiChar), kind: 'meaning' as const },
    ...VISUAL_PAIRS.map((i) => ({ id: `v-${i}`, chars: [kanjiChar(i), kanjiChar(i + 12)], kind: 'visual' as const })),
  ];

  const core: CoreWord[] = Array.from({ length: SYNTHETIC_CORE }, (_, i) => {
    const order = i + 1;
    // A third of the later words are written with an early kanji (read card once that kanji is introduced).
    const kanji = coreKanji.get(order) ?? (order > 36 && order % 3 === 0 ? [kanjiChar((order * 7) % 400)] : []);
    return {
      id: coreId(order),
      order,
      kana: `かな${order}`,
      ...(kanji.length ? { written: `${kanji[0]}${order}` } : {}),
      en: `word ${order}`,
      pos: 'noun',
      register: 'both',
      topic: 'synthetic',
      use: order <= 415 && !CORE_NO_USE.has(order),
      kanji,
      unit: Math.min(25, 1 + Math.floor(i / 64)),
    };
  });

  const grammar: GrammarPoint[] = Array.from({ length: SYNTHETIC_GRAMMAR }, (_, i) => {
    const order = i + 1;
    return {
      id: `g-${order}`,
      order,
      level: order <= 60 ? 'N5' : 'N4',
      title: `Grammar ${order}`,
      pattern: '',
      register: 'both',
      ...(RECOGNITION_ONLY.has(order) ? { recognitionOnly: true } : {}),
      prerequisites: order > 1 ? [`g-${order - 1}`] : [],
      contrastWith: [],
      explanation: '',
      examples: [],
      buildItems: [],
      drills: [],
      unit: Math.min(25, 1 + Math.floor(i / 4.6)),
    };
  });

  return {
    kana: [...kana],
    rules: [...rules],
    curriculum: { version: 2, units, confusables },
    core,
    grammar,
    wordUse: (ref) => Number(ref.slice(5)) % 10 === 0,
    wordKanji: (ref) => {
      const n = Number(ref.slice(5)) - 1_000_000;
      return n >= 0 ? [kanjiChar(Math.floor(n / 3))] : [];
    },
  };
}

/** Loads the real course from data.ts. */
export async function loadSimCourse(): Promise<SimCourse> {
  const [kana, rules, curriculum, core, grammar, words, kanji] = await Promise.all([
    loadKana(),
    loadKanaRules(),
    loadCurriculum(),
    loadCoreWords(),
    loadGrammar(),
    loadWordIndex(),
    loadKanji(),
  ]);
  return {
    kana,
    rules,
    curriculum,
    core: [...core].sort((a, b) => a.order - b.order),
    grammar: [...grammar].sort((a, b) => a.order - b.order),
    wordUse: (ref) => words.get(ref.slice(5))?.use ?? false,
    wordKanji: (ref) => words.get(ref.slice(5))?.kanji ?? [],
    components: componentMap(kanji),
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimOptions {
  course: SimCourse;
  budgetMin: DailyMinutes;
  days: number;
  seed: number;
  /** Calendar date of course day 1 (default '2026-01-05'). */
  startDate?: string;
  /** Default 500. */
  writeList?: number;
  /** Handwriting recall below FSRS prediction; default 0.94. */
  writeHandicap?: number;
  /** Default 0.8. */
  firstCheckPass?: number;
  /** Skip every Nth calendar day entirely (comeback tests); default none. */
  missDayEvery?: number;
  /** Course days on which the learner only reviews (the teach step is skipped). */
  skipTeachDays?: readonly number[];
  /** Return the final progress state (real ids) as well. */
  keepState?: boolean;
}

export interface SimDay {
  /** Course day. */
  day: number;
  /** Calendar date. */
  date: string;
  mode: GovernorOutput['mode'];
  reviews: number;
  reviewSec: number;
  newSec: number;
  strandSec: number;
  totalSec: number;
  /** Cumulative counts after the day. */
  kana: number;
  kanji: number;
  words: number;
  grammar: number;
  newKanjiToday: number;
  newGrammarToday: number;
  /** Meaning-confusable members (numbers, weekdays) introduced that day (the most of any one set). */
  numbersToday: number;
  /** Kana rule ids introduced that day. */
  rulesToday: string[];
  /** Basic kana introduced that day. */
  kanaToday: number;
  /** Core words introduced through the core stream that day. */
  coreToday: number;
}

export interface SimState {
  items: ItemRecord[];
  cards: CardRecord[];
  logs: ReviewLogRecord[];
  days: DayRecord[];
  staged: StagedWordRecord[];
}

const SITTING_HOUR = 9;

function sittingTime(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, SITTING_HOUR, 0, 0, 0);
}

function nextDayStart(date: string): Date {
  const [y, m, d] = addDays(date, 1).split('-').map(Number);
  return new Date(y, m - 1, d, 4, 0, 0, 0);
}

interface DayAccuracy { date: string; n: number; pass: number; studyMs: number; catchUp: boolean }

/**
 * Systematic sampling: each draw passes with exactly its own probability, but one random offset is shared by a
 * day's draws, so the day's pass count is within one of its expected value. The simulator models the expected
 * load; independent draws would add day-to-day noise that the governor's accuracy brake then amplifies.
 */
function systematicSampler(random: () => number): (p: number) => boolean {
  let level = random();
  return (p: number) => {
    const before = Math.floor(level);
    level += Math.min(1, Math.max(0, p));
    return Math.floor(level) > before;
  };
}

/**
 * pure, deterministic. Learner: a review passes with probability r (× writeHandicap for write cards); the first
 * check passes with firstCheckPass (both drawn by systematic sampling within the day); a miss is re-asked and then
 * passes; seconds = DEFAULT_SECONDS (+ 8 s per miss).
 */
export function simulate(opts: SimOptions): { days: SimDay[]; state?: SimState } {
  const { course, budgetMin } = opts;
  const random = seededRandom(opts.seed);
  const writeList = opts.writeList ?? DEFAULT_WRITE_LIST;
  const writeHandicap = opts.writeHandicap ?? 0.94;
  const firstCheckPass = opts.firstCheckPass ?? 0.8;
  const startDate = opts.startDate ?? '2026-01-05';
  const skipTeach = new Set(opts.skipTeachDays ?? []);
  const scheduler = getScheduler(0.9);
  const sec = DEFAULT_SECONDS;

  const coreById = new Map(course.core.map((w) => [w.id, w]));
  const grammarById = new Map(course.grammar.map((g) => [g.id, g]));
  const unitByChar = new Map(course.curriculum.units.map((u) => [u.char, u]));
  const meaningSets = course.curriculum.confusables.filter((s) => s.kind === 'meaning');
  const data: CourseData = {
    kana: course.kana,
    rules: course.rules,
    curriculum: course.curriculum,
    core: course.core,
    grammar: course.grammar,
    components: course.components,
  };

  const items = new Map<string, ItemRecord>();
  const introduced = new Map<string, string>();
  const cards = new Map<string, CardRecord>();
  const logs: ReviewLogRecord[] = [];
  const dayRecords = new Map<string, DayRecord>();
  const staged = new Map<string, StagedWordRecord>();
  const studyDays: string[] = [];
  const accuracy: DayAccuracy[] = [];
  const out: SimDay[] = [];
  let kanaCount = 0;
  let kanjiCount = 0;
  let wordCount = 0;
  let grammarCount = 0;

  const kanjiOfItem = (id: string): string[] => {
    if (id.startsWith('core:')) return coreById.get(id.slice(5))?.kanji ?? [];
    if (id.startsWith('word:')) return course.wordKanji?.(id as WordRef) ?? [];
    return [];
  };
  const groupsCache = new Map<string, string[]>();
  const groupsOf = (card: CardRecord) => {
    let g = groupsCache.get(card.id);
    if (!g) groupsCache.set(card.id, (g = siblingGroups(card, kanjiOfItem(card.itemId))));
    return g;
  };
  const rankOf = (char: string) => (unitByChar.get(char)?.index ?? Number.MAX_SAFE_INTEGER) + 1;
  const valueOf = (card: CardRecord): 0 | 1 | 2 => {
    if (card.kind === 'kanji' && card.type === 'write') return rankOf(card.itemId.slice(6)) <= writeList ? 2 : 0;
    if (card.kind === 'word') return course.wordUse(card.itemId as WordRef) ? 1 : 0;
    if (card.kind === 'core') return coreById.get(card.itemId.slice(5))?.use ? 1 : 0;
    return 0;
  };

  const addItem = (kind: ItemKind, key: string, now: Date, ctx: CardTypeContext, via: ItemRecord['via']): boolean => {
    const id = itemId(kind, key);
    const existing = items.get(id);
    if (!existing) {
      const item: ItemRecord = { id, kind, key, introducedAt: now, via };
      if (kind === 'core' && ctx.spelled) item.spelledAt = now;
      items.set(id, item);
      introduced.set(id, dayKeyOf(now));
      if (kind === 'kana') kanaCount++;
      else if (kind === 'kanji') kanjiCount++;
      else if (kind === 'word' || kind === 'core') wordCount++;
      else if (kind === 'grammar') grammarCount++;
    }
    for (const type of cardTypesFor(kind, key, ctx)) {
      const card = newCardRecord(id, kind, type, now);
      if (!cards.has(card.id)) cards.set(card.id, card);
    }
    return !existing;
  };
  const dayKeyOf = (now: Date) => {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  /** The anchor/staged rows of introducePlanItem. Returns [item created, spelling upgrade]. */
  const addWordRef = (ref: WordRef, now: Date, via: ItemRecord['via']): [boolean, boolean] => {
    const key = ref.slice(5);
    if (ref.startsWith('core:')) {
      const existing = items.get(ref);
      if (existing) {
        const card = newCardRecord(ref, 'core', 'read', now);
        if (cards.has(card.id)) return [false, true];
        cards.set(card.id, card);
        if (!existing.spelledAt) existing.spelledAt = now;
        return [true, true];
      }
      return [addItem('core', key, now, { use: coreById.get(key)?.use ?? false, spelled: true }, via), false];
    }
    return [addItem('word', key, now, { use: course.wordUse(ref) }, via), false];
  };

  const introduce = (plan: NewItemPlan, now: Date, day: DayRecord): void => {
    const today = dayKeyOf(now);
    let created = false;
    let upgrade = false;
    switch (plan.kind) {
      case 'kana':
      case 'kanaRule':
        created = addItem(plan.kind, plan.key, now, {}, 'lesson');
        break;
      case 'grammar':
        created = addItem('grammar', plan.key, now, { recognitionOnly: grammarById.get(plan.key)?.recognitionOnly ?? false }, 'lesson');
        break;
      case 'core': {
        const word = coreById.get(plan.key);
        const kanji = word?.kanji ?? [];
        const spelled = kanji.length > 0 && kanji.every((c) => items.has(itemId('kanji', c)));
        created = addItem('core', plan.key, now, { use: word?.use ?? false, spelled }, 'lesson');
        const row = spelled ? staged.get(plan.itemId) : undefined;
        if (row && !row.releasedAt) row.releasedAt = now;
        break;
      }
      case 'kanji': {
        const unit = unitByChar.get(plan.key);
        const anchor = plan.anchor ?? null;
        created = addItem('kanji', plan.key, now, { zeroWord: anchor === null }, 'lesson');
        if (anchor) addWordRef(anchor, now, 'lesson');
        if (created) {
          (unit?.staged ?? []).slice(0, STAGED_RELEASE_DAYS.length).forEach((ref, slot) => {
            const item = items.get(ref);
            const useful = !item || (item.kind === 'core' && !cards.has(`${ref}|read`));
            if (staged.has(ref) || !useful) return;
            staged.set(ref, { itemId: ref, kanji: plan.key, releaseDay: addDays(today, STAGED_RELEASE_DAYS[slot]), slot: (slot + 2) as 2 | 3 });
          });
        }
        break;
      }
      case 'staged': {
        [created, upgrade] = addWordRef(plan.itemId as WordRef, now, 'staged');
        const row = staged.get(plan.itemId);
        if (row && !row.releasedAt) row.releasedAt = now;
        break;
      }
    }
    if (created) {
      if (!upgrade) day.newItems += 1;
      day.newSec[plan.stream] += plan.priceSec;
    }
  };

  const grade = (card: CardRecord, g: Grade, now: Date, context: ReviewContext): CardRecord => {
    const next = nextCard(card, g, now, scheduler);
    if (next.kind === 'kanji' && next.type === 'write' && shouldRetire(next, rankOf(next.itemId.slice(6)), writeList, false)) {
      next.suspended = 'retired';
    }
    cards.set(next.id, next);
    if (opts.keepState) {
      logs.push({
        cardId: card.id,
        itemId: card.itemId,
        kind: card.kind,
        type: card.type,
        grade: g,
        reviewedAt: now,
        durationMs: sec[timingKeyOf(card.kind, card.type)] * 1000,
        mode: card.type === 'write' ? 'written' : 'typed',
        prevState: card.state,
        elapsedDays: elapsedDaysOf(card, now),
        context,
      });
    }
    return next;
  };

  let calendar = 0;
  while (out.length < opts.days) {
    const date = addDays(startDate, calendar);
    calendar++;
    if (opts.missDayEvery && opts.missDayEvery > 1 && calendar % opts.missDayEvery === 0) continue;
    const now = sittingTime(date);
    const snapshot = buildSnapshot(data, {
      today: date,
      known: {},
      introduced,
      studyDays,
      staged: [...staged.values()],
      travel: false,
    });
    const courseDayNow = snapshot.courseDay;
    let candidates: StreamCandidates = streamCandidates(snapshot);
    if (skipTeach.has(courseDayNow)) {
      candidates = { kana: [], kanaRule: null, kanji: [], core: [], grammar: null, grammarBelowFloor: false, staged: [] };
    }

    // Warm-up candidates and the 7-day forecast.
    const warm: WarmupCard[] = [];
    const upcoming: TimingKey[] = [];
    const horizon = now.getTime() + 7 * DAY_MS;
    for (const card of cards.values()) {
      if (card.suspended || card.state === State.New) continue;
      const due = card.due.getTime();
      if (due <= now.getTime()) {
        warm.push({
          id: card.id,
          itemId: card.itemId,
          type: card.type,
          state: card.state,
          r: retrievability(card, now),
          due: card.due,
          introducedDay: introduced.get(card.itemId) ?? date,
          groups: groupsOf(card),
          value: valueOf(card),
        });
      } else if (due <= horizon) {
        upcoming.push(timingKeyOf(card.kind, card.type));
      }
    }
    const warmById = new Map(warm.map((w) => [w.id, w]));
    const govDue = (order: readonly string[]): GovDueCard[] =>
      order.map((id) => {
        const w = warmById.get(id)!;
        const card = cards.get(id)!;
        return { id, key: timingKeyOf(card.kind, card.type), r: w.r, value: w.value };
      });

    const spent14: Record<SharedStream, number> = { kanji: 0, core: 0, grammar: 0 };
    for (let back = 1; back <= 14; back++) {
      const rec = dayRecords.get(addDays(date, -back));
      if (!rec) continue;
      spent14.kanji += rec.newSec.kanji;
      spent14.core += rec.newSec.core;
      spent14.grammar += rec.newSec.grammar;
    }
    const accuracyOver = (n: number): number | null => {
      const last = accuracy.slice(-n);
      const total = last.reduce((s, a) => s + a.n, 0);
      return total < 20 ? null : last.reduce((s, a) => s + a.pass, 0) / total;
    };
    const last7 = accuracy.slice(-7);
    const underBudget7 = last7.length > 0 && last7.reduce((s, a) => s + a.studyMs, 0) / last7.length <= budgetMin * 60_000;
    const previous = accuracy.at(-1);

    const yesterday = studyDays.at(-1) ?? null;
    const first = orderWarmup(warm, { yesterday, takenGroups: new Set(), catchUp: false, seed: date });
    const input: GovernorInput = {
      budgetMin,
      courseDay: courseDayNow,
      gates: snapshot.gates,
      sprintComplete: snapshot.sprintComplete,
      wordsKnown: wordCount,
      seconds: sec,
      due: govDue(first.order),
      upcoming,
      candidates,
      spent14,
      today: { kanji: 0, core: 0, staged: 0, grammar: 0, newSec: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 }, reviewSec: 0, strandSec: 0, catchUp: false },
      accuracy3: accuracyOver(3),
      accuracy7: accuracyOver(7),
      underBudget7,
      catchUpBefore: previous?.catchUp ?? false,
      travel: false,
      extraKanji: false,
    };
    let plan = govern(input);
    let bury = first.bury;
    if (plan.mode === 'catch-up') {
      const spacedOrder = orderWarmup(warm, { yesterday, takenGroups: new Set(), catchUp: true, seed: date });
      plan = govern({ ...input, due: govDue(spacedOrder.order) });
      bury = [];
    }
    const buryUntil = nextDayStart(date);
    for (const id of bury) {
      const card = cards.get(id)!;
      if (card.due < buryUntil) cards.set(id, { ...card, due: buryUntil });
    }

    const day = emptyDay(date);
    const passes = systematicSampler(random);
    let reviewSecSpent = 0;
    let pass = 0;
    let reviewed = 0;
    for (const id of plan.reviews) {
      let card = cards.get(id)!;
      const s = sec[timingKeyOf(card.kind, card.type)];
      const p = retrievability(card, now) * (card.type === 'write' ? writeHandicap : 1);
      const ok = passes(p);
      const wasReview = card.state === State.Review;
      card = grade(card, ok ? Rating.Good : Rating.Again, now, 'review');
      reviewSecSpent += s;
      day.reviews++;
      if (ok) day.correct++;
      if (wasReview) {
        reviewed++;
        if (ok) pass++;
      }
      if (!ok) {
        grade(card, Rating.Good, now, 're-ask');
        reviewSecSpent += s + 8;
        day.reviews++;
        day.correct++;
      }
    }

    const kanjiBefore = kanjiCount;
    const grammarBefore = grammarCount;
    const kanaBefore = kanaCount;
    const introducedToday: string[] = [];
    for (const item of plan.newItems) {
      const before = items.size;
      introduce(item, now, day);
      if (items.size > before || item.kind === 'kanji') introducedToday.push(item.itemId);
    }
    // First check: every New card.
    for (const card of [...cards.values()]) {
      if (card.state !== State.New || card.suspended) continue;
      const ok = passes(firstCheckPass);
      const next = grade(card, ok ? Rating.Good : Rating.Again, now, 'first-check');
      day.reviews++;
      if (ok) day.correct++;
      else {
        grade(next, Rating.Good, now, 'first-check');
        day.reviews++;
        day.correct++;
      }
    }

    day.reviewMs = Math.round(reviewSecSpent * 1000);
    day.strandMs = plan.seconds.strands * 1000;
    day.studyMs = day.reviewMs + totalNewSec(day.newSec) * 1000 + day.strandMs;
    day.minimumDone = true;
    day.goalMet = true;
    if (plan.mode === 'catch-up') day.catchUp = true;
    dayRecords.set(date, day);
    if (isStudyDay(day)) studyDays.push(date);
    accuracy.push({ date, n: reviewed, pass, studyMs: day.studyMs, catchUp: plan.mode === 'catch-up' });

    const kanjiToday = new Set(introducedToday.filter((id) => id.startsWith('kanji:')).map((id) => id.slice(6)));
    out.push({
      day: courseDayNow,
      date,
      mode: plan.mode,
      reviews: plan.reviews.length,
      reviewSec: plan.seconds.reviews,
      newSec: plan.seconds.newPlanned,
      strandSec: plan.seconds.strands,
      totalSec: plan.seconds.dayTotal,
      kana: kanaCount,
      kanji: kanjiCount,
      words: wordCount,
      grammar: grammarCount,
      newKanjiToday: kanjiCount - kanjiBefore,
      newGrammarToday: grammarCount - grammarBefore,
      numbersToday: Math.max(0, ...meaningSets.map((set) => set.chars.filter((c) => kanjiToday.has(c)).length)),
      rulesToday: plan.newItems.filter((i) => i.kind === 'kanaRule').map((i) => i.key),
      kanaToday: kanaCount - kanaBefore,
      coreToday: plan.newItems.filter((i) => i.kind === 'core').length,
    });
  }

  if (!opts.keepState) return { days: out };
  return {
    days: out,
    state: {
      items: [...items.values()],
      cards: [...cards.values()],
      logs,
      days: [...dayRecords.values()],
      staged: [...staged.values()],
    },
  };
}
