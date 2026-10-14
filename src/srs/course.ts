// Course order: what to learn next.
//
// The core track is the kana course (hiragana basic → dakuten/handakuten →
// yōon, then katakana the same way) followed by the curriculum units (radicals
// and kanji, each kanji with up to 3 words). Survival words (max 2 a day, once
// all their kana are known) and grammar points (one every 2nd study day) are
// mixed in alongside it.

import { dayKey, db, getSettings, itemId } from '../lib/db.ts';
import { loadCurriculum, loadGrammar, loadKana, loadSurvivalWords } from '../lib/data.ts';
import type { Curriculum, CurriculumUnit, GrammarPoint, KanaEntry, KanaScript, SurvivalWord } from '../lib/types.ts';
import { isStudyDay } from './days.ts';
import { introduceItem, markKnownMany, type IntroduceResult } from './items.ts';

export type Phase = 1 | 2 | 3 | 4;

export type NewItemKind = 'kana' | 'radical' | 'kanji' | 'vocab' | 'grammar';

export interface NewItemPlan {
  itemId: string;
  kind: NewItemKind;
  key: string;
  /** Kanji units only: word ids (WordEntry.id) introduced together with the kanji. */
  words?: string[];
}

export const SURVIVAL_WORDS_PER_DAY = 2;

export type KnownScripts = Partial<Record<KanaScript, boolean>>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SCRIPT_RANK: Record<KanaScript, number> = { hiragana: 0, katakana: 1 };
const KIND_RANK: Record<KanaEntry['kind'], number> = { basic: 0, dakuten: 1, handakuten: 1, yoon: 2 };

/** Kana in teaching order, leaving out scripts the learner already knows. */
export function orderKanaCourse(kana: readonly KanaEntry[], known: KnownScripts = {}): KanaEntry[] {
  return kana
    .filter((k) => !known[k.script])
    .sort(
      (a, b) =>
        SCRIPT_RANK[a.script] - SCRIPT_RANK[b.script] ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.order - b.order,
    );
}

/**
 * The kana-course entries needed to read `text`: yōon count as one unit
 * (きょう → きょ, う); っ, ー, small vowels and anything outside the course are
 * ignored.
 */
export function requiredKana(text: string, course: ReadonlySet<string>): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] ?? '');
    if (course.has(pair)) {
      out.push(pair);
      i++;
    } else if (course.has(chars[i])) {
      out.push(chars[i]);
    }
  }
  return out;
}

/**
 * Grammar comes every 2nd study day: due unless a grammar point was introduced
 * today, or on the most recent study day before today.
 */
export function grammarDueToday(grammarDays: readonly string[], studyDays: readonly string[], today: string): boolean {
  const last = grammarDays.reduce<string | undefined>((max, d) => (!max || d > max ? d : max), undefined);
  if (!last) return true;
  if (last >= today) return false;
  return studyDays.some((d) => d > last && d < today);
}

/** Everything nextNewItems and currentPhase need, already loaded. */
export interface CourseSnapshot {
  kana: KanaEntry[];
  curriculum: Curriculum;
  survival: SurvivalWord[];
  grammar: GrammarPoint[];
  /** Ids of every introduced item. */
  introduced: ReadonlySet<string>;
  knowsHiragana: boolean;
  knowsKatakana: boolean;
  /** See grammarDueToday. */
  grammarDue: boolean;
  /** Survival words already introduced today. */
  vocabToday: number;
}

type PhaseInput = Pick<CourseSnapshot, 'kana' | 'curriculum' | 'introduced' | 'knowsHiragana' | 'knowsKatakana'>;

function knownScripts(s: Pick<CourseSnapshot, 'knowsHiragana' | 'knowsKatakana'>): KnownScripts {
  return { hiragana: s.knowsHiragana, katakana: s.knowsKatakana };
}

const kanaId = (char: string) => itemId('kana', char);
const unitId = (unit: CurriculumUnit) => itemId(unit.type, unit.char);

function basicKanaDone(s: PhaseInput, script?: KanaScript): boolean {
  const known = knownScripts(s);
  return s.kana.every(
    (k) => k.kind !== 'basic' || (script && k.script !== script) || known[k.script] || s.introduced.has(kanaId(k.char)),
  );
}

/**
 * Phase 1 until every basic hiragana and katakana is introduced (or the script
 * is marked as known); then the phase of the first curriculum unit not yet
 * introduced; 4 once the curriculum is finished. An empty curriculum (data not
 * built) leaves the learner in phase 2 rather than unlocking everything.
 */
export function phaseFor(s: PhaseInput): Phase {
  if (!basicKanaDone(s)) return 1;
  const next = s.curriculum.units.find((u) => !s.introduced.has(unitId(u)));
  if (!next) return s.curriculum.units.length ? 4 : 2;
  return Math.min(4, Math.max(2, next.phase)) as Phase;
}

/** Kana the learner can read: introduced ones plus whole scripts they already know. */
export function knownKanaSet(s: Pick<CourseSnapshot, 'kana' | 'introduced' | 'knowsHiragana' | 'knowsKatakana'>): Set<string> {
  const known = knownScripts(s);
  return new Set(s.kana.filter((k) => known[k.script] || s.introduced.has(kanaId(k.char))).map((k) => k.char));
}

function coreQueue(s: CourseSnapshot): NewItemPlan[] {
  const kana = orderKanaCourse(s.kana, knownScripts(s))
    .filter((k) => !s.introduced.has(kanaId(k.char)))
    .map((k): NewItemPlan => ({ itemId: kanaId(k.char), kind: 'kana', key: k.char }));
  const units = s.curriculum.units
    .filter((u) => !s.introduced.has(unitId(u)))
    .sort((a, b) => a.index - b.index)
    .map((u): NewItemPlan => {
      const plan: NewItemPlan = { itemId: unitId(u), kind: u.type, key: u.char };
      if (u.type === 'kanji') plan.words = u.words.filter((w) => !s.introduced.has(itemId('word', w)));
      return plan;
    });
  return [...kana, ...units];
}

function nextGrammar(s: CourseSnapshot, phase: Phase): GrammarPoint | undefined {
  // Phase-1 drills are written in hiragana, so they wait until it can be read.
  if (phase === 1 && !s.knowsHiragana && !basicKanaDone(s, 'hiragana')) return undefined;
  return s.grammar
    .filter((g) => g.phase <= phase && !s.introduced.has(itemId('grammar', g.id)))
    .sort((a, b) => a.order - b.order)[0];
}

function eligibleSurvivalWords(s: CourseSnapshot): SurvivalWord[] {
  const course = new Set(s.kana.map((k) => k.char));
  const known = knownKanaSet(s);
  return s.survival.filter(
    (w) => !s.introduced.has(itemId('vocab', w.id)) && requiredKana(w.kana, course).every((k) => known.has(k)),
  );
}

/**
 * Today's next `count` new items. At least half the slots go to the core track
 * while it lasts; the rest take a grammar point (when due) and survival words.
 * Core items come first, so words and grammar are taught after the kana/kanji.
 */
export function planNewItems(s: CourseSnapshot, count: number): NewItemPlan[] {
  if (count <= 0) return [];
  const phase = phaseFor(s);
  const core = coreQueue(s);
  let free = count - Math.min(core.length, Math.ceil(count / 2));

  const extras: NewItemPlan[] = [];
  const grammar = s.grammarDue && free > 0 ? nextGrammar(s, phase) : undefined;
  if (grammar) free -= 1;

  const vocabRoom = Math.min(free, Math.max(0, SURVIVAL_WORDS_PER_DAY - s.vocabToday));
  for (const w of eligibleSurvivalWords(s).slice(0, vocabRoom)) {
    extras.push({ itemId: itemId('vocab', w.id), kind: 'vocab', key: w.id });
  }
  if (grammar) extras.push({ itemId: itemId('grammar', grammar.id), kind: 'grammar', key: grammar.id });

  return [...core.slice(0, count - extras.length), ...extras];
}

// ---------------------------------------------------------------------------
// Database-backed API
// ---------------------------------------------------------------------------

async function loadSnapshot(now: Date): Promise<CourseSnapshot> {
  const [kana, curriculum, survival, grammar] = await Promise.all([
    loadKana(),
    loadCurriculum(),
    loadSurvivalWords(),
    loadGrammar(),
  ]);
  const settings = await getSettings();
  const introduced = new Set(await db.items.toCollection().primaryKeys());
  const dated = await db.items.where('kind').anyOf('grammar', 'vocab').toArray();
  const days = await db.days.toArray();

  const today = dayKey(now);
  const grammarDays = dated.filter((i) => i.kind === 'grammar').map((i) => dayKey(i.introducedAt));
  const studyDays = days.filter(isStudyDay).map((d) => d.date);
  return {
    kana,
    curriculum,
    survival,
    grammar,
    introduced,
    knowsHiragana: settings.knowsHiragana,
    knowsKatakana: settings.knowsKatakana,
    grammarDue: grammarDueToday(grammarDays, studyDays, today),
    vocabToday: dated.filter((i) => i.kind === 'vocab' && dayKey(i.introducedAt) === today).length,
  };
}

/** The next `count` new items to teach (read-only; see introducePlanItem). */
export async function nextNewItems(count: number, now: Date = new Date()): Promise<NewItemPlan[]> {
  if (count <= 0) return [];
  return planNewItems(await loadSnapshot(now), count);
}

async function loadPhaseInput(): Promise<PhaseInput> {
  const [kana, curriculum] = await Promise.all([loadKana(), loadCurriculum()]);
  const settings = await getSettings();
  const introduced = new Set(await db.items.toCollection().primaryKeys());
  return { kana, curriculum, introduced, knowsHiragana: settings.knowsHiragana, knowsKatakana: settings.knowsKatakana };
}

export async function currentPhase(): Promise<Phase> {
  return phaseFor(await loadPhaseInput());
}

/**
 * Introduces a planned item together with its words, in one transaction. Only
 * the main item counts toward the day's new items.
 */
export function introducePlanItem(plan: NewItemPlan, now: Date = new Date()): Promise<IntroduceResult[]> {
  return db.transaction('rw', db.items, db.cards, db.days, async () => {
    const results = [await introduceItem(plan.kind, plan.key, now)];
    for (const word of plan.words ?? []) results.push(await introduceItem('word', word, now));
    return results;
  });
}

/**
 * Marks every kana of the scripts the learner said they know (settings
 * knowsHiragana / knowsKatakana) as known, which also moves them past phase 1.
 * Onboarding and Settings call this after changing those settings; it is safe
 * to call repeatedly. Returns how many kana it covered.
 */
export async function applyKnownKana(now: Date = new Date()): Promise<number> {
  const known = knownScripts(await getSettings());
  const kana = (await loadKana()).filter((k) => known[k.script]);
  await markKnownMany(kana.map((k) => ({ kind: 'kana' as const, key: k.char })), now);
  return kana.length;
}

export interface CourseProgress {
  phase: Phase;
  kanaIntroduced: number;
  kanaTotal: number;
  unitsIntroduced: number;
  unitsTotal: number;
  kanjiIntroduced: number;
  /**
   * Target for reaching the next phase, in the current phase's measure: basic
   * kana (phase 1) or kanji introduced (phases 2–3). Null in phase 4.
   */
  nextPhaseAt: number | null;
  /** Progress toward nextPhaseAt, in the same measure. */
  phaseDone: number;
}

export function progressFor(s: PhaseInput): CourseProgress {
  const phase = phaseFor(s);
  const kanaIntroduced = s.kana.filter((k) => s.introduced.has(kanaId(k.char))).length;
  const unitsIntroduced = s.curriculum.units.filter((u) => s.introduced.has(unitId(u))).length;
  const kanjiIntroduced = [...s.introduced].filter((id) => id.startsWith('kanji:')).length;

  let nextPhaseAt: number | null = null;
  let phaseDone = kanjiIntroduced;
  if (phase === 1) {
    const known = knownScripts(s);
    const basic = s.kana.filter((k) => k.kind === 'basic');
    nextPhaseAt = basic.length;
    phaseDone = basic.filter((k) => known[k.script] || s.introduced.has(kanaId(k.char))).length;
  } else if (phase < 4) {
    const end = s.curriculum.phaseEnds[String(phase)] ?? s.curriculum.units.length;
    nextPhaseAt = s.curriculum.units.filter((u) => u.type === 'kanji' && u.index < end).length;
  }

  return {
    phase,
    kanaIntroduced,
    kanaTotal: s.kana.length,
    unitsIntroduced,
    unitsTotal: s.curriculum.units.length,
    kanjiIntroduced,
    nextPhaseAt,
    phaseDone,
  };
}

export async function courseProgress(): Promise<CourseProgress> {
  return progressFor(await loadPhaseInput());
}
