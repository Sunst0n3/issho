// Course order: the kana sprint, the phase gates and the candidates of each
// new-learning stream (kana, kanji with anchors and staged words, core words,
// grammar), plus the placement check.
//
// Everything here is planned from progress, never from the calendar: the course
// day counts study days, and the sprint teaches the oldest untaught row first, so
// a day with only reviews (or a missed day) never loses a row.

import { dayKey, db, getSettings, itemId, updateSettings } from '../lib/db.ts';
import {
  loadCoreIndex,
  loadCoreWords,
  loadCurriculum,
  loadGrammar,
  loadGrammarIndex,
  loadKana,
  loadKanaRules,
  loadKanji,
  loadWordIndex,
} from '../lib/data.ts';
import type {
  ConfusableSet,
  CoreWord,
  Curriculum,
  CurriculumUnit,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanaRuleId,
  KanaScript,
  KanjiEntry,
  NewStream,
  StagedWordRecord,
  WordRef,
} from '../lib/types.ts';
import { addDays, isStudyDay, normalizeDay, updateDay, weekStart } from './days.ts';
import { GRAMMAR_FLOOR_PER_WEEK, PRICE_SEC } from './governor.ts';
import { introduceItem, markKnownMany, upgradeSpelling, type IntroduceResult, type ItemRef2 } from './items.ts';
import { shuffle } from './random.ts';

export type KnownScripts = Partial<Record<KanaScript, boolean>>;

export interface SprintDay {
  /** Course day (1-based). */
  day: number;
  script: KanaScript;
  /** Basic kana taught today (row lessons), chart order. */
  kana: string[];
  rule?: KanaRuleId;
  /** Last sprint day: the 'Kana check' can-do (read 10 katakana menu words aloud at speed). */
  kanaCheck?: boolean;
}

/** Most basic kana taught on one study day. */
export const SPRINT_KANA_PER_DAY = 10;
/** Kanji units looked at past a deferred one (confusable spacing). */
export const KANJI_LOOKAHEAD = 10;
export const KANJI_CANDIDATES = 4;
export const CORE_CANDIDATES = 3;
export const GRAMMAR_LOOKAHEAD = 3;
export const STAGED_CANDIDATES = 4;
/** Visual confusables and contrasting grammar points: at least this many study days apart. */
export const CONTRAST_STUDY_DAYS = 5;
/** Meaning confusables (numbers, weekdays): at most this many members a day. */
export const MEANING_PER_DAY = 3;
/** Staged words: calendar days after their kanji (slot 2, slot 3). */
export const STAGED_RELEASE_DAYS = [3, 8] as const;

const SCRIPTS: readonly KanaScript[] = ['hiragana', 'katakana'];
/** Sprint days of a script in the data, before a known script is left out: hiragana 1–7, katakana 8–14. */
const SCRIPT_BASE: Record<KanaScript, number> = { hiragana: 0, katakana: 7 };

/**
 * pure. Hiragana: days 1–5 rows (KanaEntry.sprintDay), 6 hira-dakuten, 7 hira-yoon; katakana: 8–12 rows,
 * 13 kata-dakuten-yoon, 14 kata-extended. A known script is left out and the other moves to days 1–7.
 */
export function kanaSprint(kana: readonly KanaEntry[], rules: readonly KanaRule[], known: KnownScripts): SprintDay[] {
  const days: SprintDay[] = [];
  let offset = 0;
  for (const script of SCRIPTS) {
    if (known[script]) continue;
    const base = SCRIPT_BASE[script];
    const rows = new Map<number, KanaEntry[]>();
    for (const k of kana) {
      if (k.script !== script || k.kind !== 'basic' || k.sprintDay === undefined) continue;
      const day = k.sprintDay - base;
      rows.set(day, [...(rows.get(day) ?? []), k]);
    }
    for (const [day, entries] of rows) {
      days.push({ day: offset + day, script, kana: entries.sort((a, b) => a.order - b.order).map((k) => k.char) });
    }
    for (const rule of rules) {
      if (rule.script !== script) continue;
      days.push({ day: offset + rule.day - base, script, kana: [], rule: rule.id });
    }
    offset += 7;
  }
  days.sort((a, b) => a.day - b.day);
  if (days.length) days[days.length - 1].kanaCheck = true;
  return days;
}

export interface CourseGates { coreFrom: number; grammarFrom: number; kanjiFrom: number; governorFrom: number }

/**
 * pure. Neither script known: core 3, grammar 8, kanji/governor 15. Hiragana known: core 1, grammar 1,
 * kanji/governor 8. Only katakana known: core 3, grammar 8, kanji/governor 8. Both known: all 1.
 * kanjiFrom and governorFrom apply only once the sprint content is complete (CourseSnapshot.sprintComplete).
 */
export function courseGates(known: KnownScripts): CourseGates {
  if (known.hiragana && known.katakana) return { coreFrom: 1, grammarFrom: 1, kanjiFrom: 1, governorFrom: 1 };
  if (known.hiragana) return { coreFrom: 1, grammarFrom: 1, kanjiFrom: 8, governorFrom: 8 };
  if (known.katakana) return { coreFrom: 3, grammarFrom: 8, kanjiFrom: 8, governorFrom: 8 };
  return { coreFrom: 3, grammarFrom: 8, kanjiFrom: 15, governorFrom: 15 };
}

export interface SprintPick { kana: string[]; rule: KanaRuleId | null }

/**
 * pure. Sprint content from progress, not from the calendar. Walk the sprint days 1..min(courseDay, sprint.length)
 * in order and collect their basic kana not yet introduced, in chart order, at most 10 a day (sprint kana introduced
 * earlier today count). rule: the first rule of a walked day not yet introduced, only when no sprint rule was
 * introduced today and every basic kana of its script is introduced or in `kana`; at most one a day (taught after the
 * rows). Only the sprint's own content counts as taught today: the known script's kana and rules, which the placement
 * check introduces (usually on day 1 itself), never use up the day's lessons.
 */
export function sprintPick(sprint: readonly SprintDay[], introduced: ReadonlyMap<string, string>, today: string, courseDay: number): SprintPick {
  const walked = sprint.filter((d) => d.day <= courseDay);
  const sprintIds = new Set(sprintItemIds(sprint));
  let kanaToday = 0;
  let ruleToday = false;
  for (const [id, day] of introduced) {
    if (day !== today || !sprintIds.has(id)) continue;
    if (id.startsWith('kana:')) kanaToday++;
    else if (id.startsWith('kanaRule:')) ruleToday = true;
  }
  const limit = Math.max(0, SPRINT_KANA_PER_DAY - kanaToday);
  const kana: string[] = [];
  for (const day of walked) {
    for (const c of day.kana) {
      if (kana.length < limit && !introduced.has(itemId('kana', c))) kana.push(c);
    }
  }
  let rule: KanaRuleId | null = null;
  if (!ruleToday) {
    const next = walked.find((d) => d.rule && !introduced.has(itemId('kanaRule', d.rule)));
    if (next?.rule) {
      const scriptKana = sprint.filter((d) => d.script === next.script).flatMap((d) => d.kana);
      if (scriptKana.every((c) => introduced.has(itemId('kana', c)) || kana.includes(c))) rule = next.rule;
    }
  }
  return { kana, rule };
}

/** pure. 1 + the number of distinct study days (DayRecord isStudyDay) strictly before `today`. */
export function courseDayFrom(studyDays: readonly string[], today: string): number {
  return 1 + new Set(studyDays.filter((d) => d < today)).size;
}

/** Sorted distinct study days before `today`. */
async function studyDaysBefore(today: string): Promise<string[]> {
  const days = await db.days.where('date').below(today).toArray();
  return days.filter((d) => isStudyDay(normalizeDay(d, d.date))).map((d) => d.date).sort();
}

export async function courseDay(now: Date = new Date()): Promise<number> {
  const today = dayKey(now);
  return courseDayFrom(await studyDaysBefore(today), today);
}

/**
 * pure: study days between `from` and `today`, counting the index distance in studyDays + [today]
 * (the number of study days d with from < d ≤ today; today always counts).
 */
export function studyDaysApart(from: string, today: string, studyDays: readonly string[]): number {
  if (from >= today) return 0;
  let n = 1; // today
  for (const d of studyDays) if (d > from && d < today) n++;
  return n;
}

export type NewItemKind = 'kana' | 'kanaRule' | 'kanji' | 'core' | 'grammar' | 'staged';

export interface NewItemPlan {
  /** 'kana:あ', 'kanaRule:hira-yoon', 'kanji:水', 'core:cw-0012', 'grammar:wa-desu', staged: 'word:…'|'core:…' */
  itemId: string;
  kind: NewItemKind;
  key: string;
  /** kanji: its anchor word, introduced with it (null for zero-word kanji). */
  anchor?: WordRef | null;
  /** staged: the kanji it belongs to. */
  kanji?: string;
  /** staged core ref that is already an introduced core item: spelling upgrade (adds its read card only). */
  upgrade?: boolean;
  /** Seconds the governor priced it at (PRICE_SEC). */
  priceSec: number;
  /** kana/kanaRule → 'sprint'; staged → 'staged' (outside the 60/20/20 shares); else its own stream. */
  stream: NewStream;
}

export interface CourseSnapshot {
  today: string;
  courseDay: number;
  known: KnownScripts;
  sprint: SprintDay[];
  gates: CourseGates;
  /** Every basic kana and rule of `sprint` is introduced (true when the sprint is empty). */
  sprintComplete: boolean;
  /** Sprint display rules apply (romaji typing on kana-read cards, the romaji helper): sprint content is incomplete,
   *  or it was completed today. False when both scripts are known. */
  inSprint: boolean;
  kana: KanaEntry[];
  rules: KanaRule[];
  curriculum: Curriculum;
  core: CoreWord[];
  grammar: GrammarPoint[];
  /** itemId → day key it was introduced. */
  introduced: ReadonlyMap<string, string>;
  /** Sorted study days before today (for "study days apart" rules). */
  studyDays: readonly string[];
  staged: readonly StagedWordRecord[];
  travel: boolean;
  /** Kanji → its component kanji (kanji.json): a kanji waits while a look-alike holds back one of its parts. */
  components?: ReadonlyMap<string, readonly string[]>;
}

/** The course data a snapshot is built from. */
export interface CourseData {
  kana: KanaEntry[];
  rules: KanaRule[];
  curriculum: Curriculum;
  core: CoreWord[];
  grammar: GrammarPoint[];
  /** Kanji → its component kanji (kanji.json `components`), for kanji only; absent in synthetic courses. */
  components?: ReadonlyMap<string, readonly string[]>;
}

/** pure: kanji → component kanji, for the kanji that have any (CourseData.components). */
export function componentMap(kanji: Readonly<Record<string, Pick<KanjiEntry, 'components'>>>): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [char, k] of Object.entries(kanji)) if (k.components.length > 0) out.set(char, k.components);
  return out;
}

/** pure: the item ids of the sprint's content (basic kana and rules). */
function sprintItemIds(sprint: readonly SprintDay[]): string[] {
  return sprint.flatMap((d) => [...d.kana.map((c) => itemId('kana', c)), ...(d.rule ? [itemId('kanaRule', d.rule)] : [])]);
}

/** pure: a snapshot from loaded data and progress (the simulator builds one per simulated day). */
export function buildSnapshot(
  data: CourseData,
  progress: {
    today: string;
    known: KnownScripts;
    introduced: ReadonlyMap<string, string>;
    studyDays: readonly string[];
    staged: readonly StagedWordRecord[];
    travel: boolean;
  },
): CourseSnapshot {
  const sprint = kanaSprint(data.kana, data.rules, progress.known);
  const sprintIds = sprintItemIds(sprint);
  const sprintComplete = sprintIds.every((id) => progress.introduced.has(id));
  let lastSprintDay = '';
  for (const id of sprintIds) {
    const day = progress.introduced.get(id);
    if (day && day > lastSprintDay) lastSprintDay = day;
  }
  const inSprint = sprint.length > 0 && (!sprintComplete || lastSprintDay === progress.today);
  return {
    ...data,
    ...progress,
    courseDay: courseDayFrom(progress.studyDays, progress.today),
    sprint,
    gates: courseGates(progress.known),
    sprintComplete,
    inSprint,
  };
}

export interface StreamCandidates {
  /** sprintPick().kana (≤ 10, oldest sprint day first). */
  kana: NewItemPlan[];
  /** sprintPick().rule. */
  kanaRule: NewItemPlan | null;
  /** Up to 4 eligible kanji (lookahead applied), price 160 (+28 with anchor). */
  kanji: NewItemPlan[];
  /** Up to 3 next core words, price 35. */
  core: NewItemPlan[];
  /** Next eligible point if allowed today, price 200. */
  grammar: NewItemPlan | null;
  /** True when this ISO week has fewer than 2 grammar points (floor): grammar goes ahead of kanji. */
  grammarBelowFloor: boolean;
  /** Due releases (releaseDay ≤ today), oldest first, up to 4, price 28. */
  staged: NewItemPlan[];
}

function refKey(ref: string): string {
  return ref.slice(ref.indexOf(':') + 1);
}

/** pure: confusable sets by member char. */
function setsByChar(sets: readonly ConfusableSet[]): Map<string, ConfusableSet[]> {
  const out = new Map<string, ConfusableSet[]>();
  for (const set of sets) for (const c of set.chars) out.set(c, [...(out.get(c) ?? []), set]);
  return out;
}

function kanjiCandidates(s: CourseSnapshot): NewItemPlan[] {
  const sets = setsByChar(s.curriculum.confusables ?? []);
  const units = new Set(s.curriculum.units.map((u) => u.char));
  const window = [...s.curriculum.units]
    .sort((a, b) => a.index - b.index)
    .filter((u) => !s.introduced.has(itemId('kanji', u.char)))
    .slice(0, KANJI_LOOKAHEAD);
  const picked: CurriculumUnit[] = [];
  const pickedChars = new Set<string>();
  const blocked = (u: CurriculumUnit): boolean => {
    for (const set of sets.get(u.char) ?? []) {
      const others = set.chars.filter((c) => c !== u.char);
      if (set.kind === 'visual') {
        for (const c of others) {
          if (pickedChars.has(c)) return true;
          const day = s.introduced.get(itemId('kanji', c));
          if (day !== undefined && studyDaysApart(day, s.today, s.studyDays) < CONTRAST_STUDY_DAYS) return true;
        }
      } else {
        const today = others.filter((c) => pickedChars.has(c) || s.introduced.get(itemId('kanji', c)) === s.today).length;
        if (today >= MEANING_PER_DAY) return true;
      }
    }
    return false;
  };
  // The build teaches each component before its first user, so a component that is neither introduced nor picked
  // was held back above (a look-alike): its users wait for it rather than come first (国 before 玉).
  const waitsForPart = (u: CurriculumUnit): boolean =>
    (s.components?.get(u.char) ?? []).some((c) => units.has(c) && !pickedChars.has(c) && !s.introduced.has(itemId('kanji', c)));
  for (const unit of window) {
    if (picked.length >= KANJI_CANDIDATES) break;
    if (blocked(unit) || waitsForPart(unit)) continue;
    picked.push(unit);
    pickedChars.add(unit.char);
  }
  return picked.map((u) => ({
    itemId: itemId('kanji', u.char),
    kind: 'kanji',
    key: u.char,
    anchor: u.anchor ?? null,
    priceSec: PRICE_SEC.kanji + (u.anchor ? PRICE_SEC.anchor : 0),
    stream: 'kanji',
  }));
}

function grammarCandidate(s: CourseSnapshot): { grammar: NewItemPlan | null; belowFloor: boolean } {
  const introducedDays = new Map<string, string>();
  for (const [id, day] of s.introduced) if (id.startsWith('grammar:')) introducedDays.set(id.slice(8), day);
  const monday = weekStart(s.today);
  let thisWeek = 0;
  for (const day of introducedDays.values()) if (day >= monday && day < s.today) thisWeek++;
  const belowFloor = thisWeek < GRAMMAR_FLOOR_PER_WEEK;

  const days = [...introducedDays.values()];
  const previous = s.studyDays.at(-1);
  if (days.includes(s.today) || (previous !== undefined && days.includes(previous))) return { grammar: null, belowFloor };

  // Contrasts are symmetric: a point lists its look-alikes, and is a look-alike of the points that list it.
  const contrasts = new Map<string, Set<string>>();
  for (const g of s.grammar) {
    for (const other of g.contrastWith) {
      contrasts.set(g.id, (contrasts.get(g.id) ?? new Set()).add(other));
      contrasts.set(other, (contrasts.get(other) ?? new Set()).add(g.id));
    }
  }
  const recent = (id: string) => {
    const day = introducedDays.get(id);
    return day !== undefined && studyDaysApart(day, s.today, s.studyDays) < CONTRAST_STUDY_DAYS;
  };
  const pending = [...s.grammar]
    .sort((a, b) => a.order - b.order)
    .filter((g) => !introducedDays.has(g.id))
    .slice(0, GRAMMAR_LOOKAHEAD);
  const next = pending.find(
    (g) => g.prerequisites.every((p) => introducedDays.has(p)) && ![...(contrasts.get(g.id) ?? [])].some(recent),
  );
  if (!next) return { grammar: null, belowFloor };
  return {
    grammar: { itemId: itemId('grammar', next.id), kind: 'grammar', key: next.id, priceSec: PRICE_SEC.grammar, stream: 'grammar' },
    belowFloor,
  };
}

/** pure: the candidates of every stream for today (rules in the design §3.1.1). */
export function streamCandidates(s: CourseSnapshot): StreamCandidates {
  const out: StreamCandidates = { kana: [], kanaRule: null, kanji: [], core: [], grammar: null, grammarBelowFloor: false, staged: [] };

  if (!s.sprintComplete) {
    const pick = sprintPick(s.sprint, s.introduced, s.today, s.courseDay);
    out.kana = pick.kana.map((c) => ({ itemId: itemId('kana', c), kind: 'kana', key: c, priceSec: PRICE_SEC.kana, stream: 'sprint' }));
    if (pick.rule) {
      out.kanaRule = { itemId: itemId('kanaRule', pick.rule), kind: 'kanaRule', key: pick.rule, priceSec: PRICE_SEC.kanaRule, stream: 'sprint' };
    }
  }

  if (s.courseDay >= s.gates.kanjiFrom && s.sprintComplete && !s.travel) out.kanji = kanjiCandidates(s);

  if (s.courseDay >= s.gates.coreFrom) {
    for (const word of s.core) {
      if (out.core.length >= CORE_CANDIDATES) break;
      const id = itemId('core', word.id);
      if (!s.introduced.has(id)) out.core.push({ itemId: id, kind: 'core', key: word.id, priceSec: PRICE_SEC.core, stream: 'core' });
    }
  }

  if (s.courseDay >= s.gates.grammarFrom && !s.travel) {
    const { grammar, belowFloor } = grammarCandidate(s);
    out.grammar = grammar;
    out.grammarBelowFloor = belowFloor;
  }

  out.staged = s.staged
    .filter((r) => !r.releasedAt && r.releaseDay <= s.today)
    .sort((a, b) => a.releaseDay.localeCompare(b.releaseDay) || a.slot - b.slot)
    .slice(0, STAGED_CANDIDATES)
    .map((r) => ({
      itemId: r.itemId,
      kind: 'staged',
      key: refKey(r.itemId),
      kanji: r.kanji,
      upgrade: r.itemId.startsWith('core:') && s.introduced.has(r.itemId),
      priceSec: PRICE_SEC.staged,
      stream: 'staged',
    }));
  return out;
}

export async function loadCourseData(): Promise<CourseData> {
  const [kana, rules, curriculum, core, grammar, kanji] = await Promise.all([
    loadKana(),
    loadKanaRules(),
    loadCurriculum(),
    loadCoreWords(),
    loadGrammar(),
    loadKanji(),
  ]);
  return {
    kana,
    rules,
    curriculum,
    core: [...core].sort((a, b) => a.order - b.order),
    grammar: [...grammar].sort((a, b) => a.order - b.order),
    components: componentMap(kanji),
  };
}

export async function loadCourseSnapshot(now: Date = new Date()): Promise<CourseSnapshot> {
  const data = await loadCourseData();
  const settings = await getSettings();
  const today = dayKey(now);
  const [items, studyDays, staged] = await Promise.all([db.items.toArray(), studyDaysBefore(today), db.staged.toArray()]);
  return buildSnapshot(data, {
    today,
    known: { hiragana: settings.knowsHiragana, katakana: settings.knowsKatakana },
    introduced: new Map(items.map((i) => [i.id, dayKey(i.introducedAt)])),
    studyDays,
    staged,
    travel: settings.travelUntil !== undefined && settings.travelUntil >= today,
  });
}

// ---------------------------------------------------------------------------
// Introducing a planned item
// ---------------------------------------------------------------------------

interface WordContexts {
  wordUse: (id: string) => boolean;
  core: (id: string) => CoreWord | undefined;
}

async function wordContexts(): Promise<WordContexts> {
  const [words, cores] = await Promise.all([loadWordIndex(), loadCoreIndex()]);
  return { wordUse: (id) => words.get(id)?.use ?? false, core: (id) => cores.get(id) };
}

/**
 * The anchor/staged rows: a JMdict word gets read (+ produce); a core word not yet introduced gets
 * listen (+ produce) + read and spelledAt; an introduced core word gets only its read card (spelling upgrade).
 */
async function introduceWordRef(
  ref: string,
  via: 'lesson' | 'staged',
  ctx: WordContexts,
  now: Date,
): Promise<{ result: IntroduceResult; upgrade: boolean }> {
  const key = refKey(ref);
  if (ref.startsWith('core:')) {
    if (await db.items.get(ref)) return { result: await upgradeSpelling(key, now), upgrade: true };
    const use = ctx.core(key)?.use ?? false;
    return { result: await introduceItem('core', key, now, { ctx: { use, spelled: true }, via }), upgrade: false };
  }
  return { result: await introduceItem('word', key, now, { ctx: { use: ctx.wordUse(key) }, via }), upgrade: false };
}

/** A staged row is only worth keeping when its release can still teach something. */
async function stagedStillUseful(ref: string): Promise<boolean> {
  const item = await db.items.get(ref);
  if (!item) return true;
  return item.kind === 'core' && !(await db.cards.get(`${ref}|read`));
}

/**
 * Introduces a planned item, its anchor and its staged rows in one rw transaction. Idempotent: a
 * second call for the same plan creates nothing and changes no DayRecord counter. Accounting (only
 * when the plan's own item, or for an upgrade its read card, was created): newItems + 1 (not for an
 * upgrade) and newSec[plan.stream] + plan.priceSec.
 */
export async function introducePlanItem(plan: NewItemPlan, now: Date = new Date()): Promise<IntroduceResult[]> {
  const today = dayKey(now);
  const [curriculum, grammar, ctx] = await Promise.all([loadCurriculum(), loadGrammarIndex(), wordContexts()]);

  return db.transaction('rw', [db.items, db.cards, db.days, db.staged], async () => {
    const results: IntroduceResult[] = [];
    let upgrade = false;
    switch (plan.kind) {
      case 'kana':
      case 'kanaRule':
        results.push(await introduceItem(plan.kind, plan.key, now));
        break;
      case 'grammar':
        results.push(await introduceItem('grammar', plan.key, now, { ctx: { recognitionOnly: grammar.get(plan.key)?.recognitionOnly ?? false } }));
        break;
      case 'core': {
        const word = ctx.core(plan.key);
        const kanji = word?.kanji ?? [];
        const spelled = kanji.length > 0 && (await db.items.bulkGet(kanji.map((c) => itemId('kanji', c)))).every(Boolean);
        results.push(await introduceItem('core', plan.key, now, { ctx: { use: word?.use ?? false, spelled } }));
        // Taught with its spelling before its staged release came round: the release would teach nothing.
        const row = spelled ? await db.staged.get(plan.itemId) : undefined;
        if (row && !row.releasedAt) await db.staged.put({ ...row, releasedAt: now });
        break;
      }
      case 'kanji': {
        const unit = curriculum.units.find((u) => u.char === plan.key);
        const anchor = plan.anchor !== undefined ? plan.anchor : (unit?.anchor ?? null);
        const own = await introduceItem('kanji', plan.key, now, { ctx: { zeroWord: anchor === null } });
        results.push(own);
        if (anchor) results.push((await introduceWordRef(anchor, 'lesson', ctx, now)).result);
        if (own.created) {
          for (const [slot, ref] of (unit?.staged ?? []).slice(0, STAGED_RELEASE_DAYS.length).entries()) {
            if ((await db.staged.get(ref)) || !(await stagedStillUseful(ref))) continue;
            await db.staged.add({
              itemId: ref,
              kanji: plan.key,
              releaseDay: addDays(today, STAGED_RELEASE_DAYS[slot]),
              slot: (slot + 2) as 2 | 3,
            });
          }
        }
        break;
      }
      case 'staged': {
        const released = await introduceWordRef(plan.itemId, 'staged', ctx, now);
        results.push(released.result);
        upgrade = released.upgrade;
        const row = await db.staged.get(plan.itemId);
        if (row && !row.releasedAt) await db.staged.put({ ...row, releasedAt: now });
        break;
      }
    }

    if (results[0]?.created) {
      await updateDay(today, (day) => {
        if (!upgrade) day.newItems += 1;
        day.newSec[plan.stream] += plan.priceSec;
      });
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export const PLACEMENT_ITEMS = 20;
export const PLACEMENT_PASS = 18;
export const PLACEMENT_STABILITY_DAYS = 10;

/** pure: 20 random basic kana of the script (pass a seeded `random` for a fixed set). */
export function placementSet(kana: readonly KanaEntry[], script: KanaScript, random: () => number = Math.random): KanaEntry[] {
  const basic = kana.filter((k) => k.script === script && k.kind === 'basic');
  return shuffle(basic, random).slice(0, PLACEMENT_ITEMS);
}

/**
 * ≥ 18 correct → 'known': the script's basic kana (read + write) and its two kana-rule items go to Review
 * (stability 10 d, due spread over 1–10 d, ItemRecord.via 'placement'), and knowsHiragana/knowsKatakana is set.
 * Otherwise 'sprint' (nothing created).
 */
export async function applyPlacement(script: KanaScript, correct: number, now: Date = new Date()): Promise<'known' | 'sprint'> {
  if (correct < PLACEMENT_PASS) return 'sprint';
  const [kana, rules] = await Promise.all([loadKana(), loadKanaRules()]);
  const refs: ItemRef2[] = [
    ...kana.filter((k) => k.script === script && k.kind === 'basic').map((k) => ({ kind: 'kana' as const, key: k.char })),
    ...rules.filter((r) => r.script === script).map((r) => ({ kind: 'kanaRule' as const, key: r.id })),
  ];
  await markKnownMany(refs, now, PLACEMENT_STABILITY_DAYS);
  await updateSettings(script === 'hiragana' ? { knowsHiragana: true } : { knowsKatakana: true });
  return 'known';
}

// ---------------------------------------------------------------------------
// Progress through the course
// ---------------------------------------------------------------------------

async function introducedIds(): Promise<Set<string>> {
  return new Set((await db.items.toCollection().primaryKeys()).map(String));
}

/** pure: the unit of the first grammar point (by order) not yet introduced; the last unit when all are. */
export function unitOfNextGrammar(grammar: readonly GrammarPoint[], introduced: ReadonlySet<string>): number {
  const sorted = [...grammar].sort((a, b) => a.order - b.order);
  const next = sorted.find((g) => !introduced.has(itemId('grammar', g.id)));
  if (next) return next.unit ?? 1;
  return sorted.length ? Math.max(...sorted.map((g) => g.unit ?? 1)) : 1;
}

/** The unit of the next grammar point to teach (25 when all are taught; 1 before any). */
export async function currentUnit(_now: Date = new Date()): Promise<number> {
  const [grammar, introduced] = await Promise.all([loadGrammar(), introducedIds()]);
  return unitOfNextGrammar(grammar, introduced);
}

export interface CourseProgressV2 {
  courseDay: number;
  /** = CourseSnapshot.sprintComplete. */
  sprintDone: boolean;
  /** Of 92 basic. */
  kanaIntroduced: number;
  /** 92. */
  kanaTotal: number;
  kanjiIntroduced: number;
  /** Curriculum units. */
  kanjiTotal: number;
  coreIntroduced: number;
  grammarIntroduced: number;
  unit: number;
  /** Every stream exhausted. */
  courseComplete: boolean;
}

export async function courseProgress(now: Date = new Date()): Promise<CourseProgressV2> {
  const s = await loadCourseSnapshot(now);
  const has = (id: string) => s.introduced.has(id);
  const basic = s.kana.filter((k) => k.kind === 'basic');
  const kanjiIntroduced = s.curriculum.units.filter((u) => has(itemId('kanji', u.char))).length;
  const coreIntroduced = s.core.filter((w) => has(itemId('core', w.id))).length;
  const grammarIntroduced = s.grammar.filter((g) => has(itemId('grammar', g.id))).length;
  return {
    courseDay: s.courseDay,
    sprintDone: s.sprintComplete,
    kanaIntroduced: basic.filter((k) => has(itemId('kana', k.char))).length,
    kanaTotal: basic.length,
    kanjiIntroduced,
    kanjiTotal: s.curriculum.units.length,
    coreIntroduced,
    grammarIntroduced,
    unit: unitOfNextGrammar(s.grammar, new Set(s.introduced.keys())),
    courseComplete:
      s.sprintComplete &&
      kanjiIntroduced === s.curriculum.units.length &&
      coreIntroduced === s.core.length &&
      grammarIntroduced === s.grammar.length,
  };
}

/** The next `n` kanji units not yet introduced, in teaching order (Library "Next up"). */
export async function nextUnits(n: number): Promise<CurriculumUnit[]> {
  if (n <= 0) return [];
  const [curriculum, introduced] = await Promise.all([loadCurriculum(), introducedIds()]);
  return [...curriculum.units]
    .sort((a, b) => a.index - b.index)
    .filter((u) => !introduced.has(itemId('kanji', u.char)))
    .slice(0, n);
}

/** pure: introduced basic kana, plus every voiced/yōon kana of an introduced rule lesson. */
export function taughtKanaFrom(rules: readonly KanaRule[], introduced: ReadonlySet<string>): Set<string> {
  const taught = new Set<string>();
  for (const id of introduced) if (id.startsWith('kana:')) taught.add(id.slice(5));
  for (const rule of rules) {
    if (introduced.has(itemId('kanaRule', rule.id))) for (const pair of rule.pairs) taught.add(pair.to);
  }
  return taught;
}

/** The taught set for romajiHelper (src/lib/ruby.ts): introduced basic kana and the kana of introduced rules. */
export async function taughtKana(_now: Date = new Date()): Promise<Set<string>> {
  const [rules, introduced] = await Promise.all([loadKanaRules(), introducedIds()]);
  return taughtKanaFrom(rules, introduced);
}

