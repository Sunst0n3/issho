// Curriculum v2 (public/data/curriculum.json): the teaching order of the jōyō kanji, with an anchor
// word and up to two staged words per kanji. See TECH-DESIGN §3.6.2.
//
// - Spine: kanji by effectiveRank = freqRank − boost (core and role-play/task target words pull
//   their kanji forward), ties by freqRank, then codepoint.
// - Components are taught before the kanji that use them, recursively, except rare ones (newspaper
//   rank > 1000, or no useful word): those are named parts of their users and keep their own place.
// - Members of a visual confusable set are kept ≥ 10 positions apart (a later one moves down).
// - Words: the best-scored candidates whose other kanji are already taught become the anchor and
//   the staged words.

import type { ConfusableSet, Curriculum, CurriculumUnit, WordRef } from '../../src/lib/types.ts';
import { soundVariants, toHiragana } from './readings.ts';
import type { OverrideWord } from './word-overrides.ts';

export interface CurriculumKanji {
  char: string;
  /** Newspaper frequency rank (KANJIDIC2, 1..2500); missing = rarer than every ranked kanji. */
  freq?: number;
  grade?: number;
  strokeCount: number;
  /** KANJIDIC kun readings ('なが.い'). */
  kun?: readonly string[];
  /** KANJIDIC on readings, katakana. */
  on?: readonly string[];
}

/** A word that can be taught with a kanji: a words.json entry (under its item ref) or a core word that has none. */
export interface UnitCandidate {
  ref: WordRef;
  /** The JMdict id of a words.json entry (word overrides name these); the core id for a core-only word. */
  id: string;
  written: string;
  kana: string;
  kanji: readonly string[];
  pos: readonly string[];
  meanings: readonly string[];
  /** JMdict priority tags of the spelling. */
  pri: readonly string[];
  freqRank: number;
  /** A core word (its item is `core:<id>`). */
  core?: boolean;
  /** The core word's teaching order: among equal scores, the more basic core word wins. */
  coreOrder?: number;
  /** Named in a role-play or task's `targets`. */
  target?: boolean;
}

export interface CurriculumInput {
  kanji: readonly CurriculumKanji[];
  /** Teachable elements of each kanji (jōyō kanji or named parts from content/radicals.json), in writing order. */
  components: ReadonlyMap<string, readonly string[]>;
  words: readonly UnitCandidate[];
  /** Spine boost per kanji (kanjiBoosts). */
  boosts?: ReadonlyMap<string, number>;
  /** Kanji with a phonetic component (KanjiVG kvg:phon): never `inferable`. */
  phonetic?: ReadonlySet<string>;
  /**
   * How many components each kanji is drawn from, a repeated one counted each time (林 = 木 + 木: 2;
   * kanjivg.ts componentCount). `components` lists 木 once, so without this 林 would not be `inferable`.
   */
  componentCounts?: ReadonlyMap<string, number>;
  confusables?: readonly ConfusableSet[];
  /** Hand-picked word lists that replace the automatic pick for some kanji (see word-overrides.ts). */
  overrides?: Readonly<Record<string, readonly OverrideWord[]>>;
  /** Reports override words that cannot be used. */
  warn?: (message: string) => void;
}

export interface CurriculumResult {
  curriculum: Curriculum;
  /** Component kanji taught before each kanji (KanjiEntry.components). */
  components: Map<string, string[]>;
  /** Named parts of each kanji: non-jōyō elements and rare components not taught before it (KanjiEntry.parts). */
  parts: Map<string, string[]>;
  /** Jōyō kanji too rare to be pulled forward as a component. */
  rare: Set<string>;
  /** Kanji placed later than their spine position to keep confusables apart. */
  spaced: string[];
}

export const MAX_UNIT_WORDS = 3;
export const CHAPTER_SIZE = 15;
/** Minimum distance in curriculum positions between members of a visual confusable set. */
export const CONFUSABLE_GAP = 10;
/** Components rarer than this newspaper rank are named parts, not pulled-forward units. */
export const RARE_FREQ = 1000;
/** freqRank for kanji without a newspaper frequency. */
export const MISSING_FREQ = 2501;
/** Spine boosts: core order ≤ 400 or a target word, core order 401–1,000, any other core word. */
export const BOOST = { early: 150, mid: 100, late: 50 } as const;
export const EARLY_CORE = 400;
export const MID_CORE = 1000;

const isKanjiChar = (ch: string) => /\p{Script=Han}/u.test(ch) && ch !== '々';

/** The spine boost of every kanji in the core words (by order) and the target words. */
export function kanjiBoosts(
  core: readonly { written?: string; order: number }[],
  targetWords: readonly string[] = [],
): Map<string, number> {
  const out = new Map<string, number>();
  const raise = (text: string | undefined, boost: number) => {
    for (const ch of text ?? '') if (isKanjiChar(ch) && boost > (out.get(ch) ?? 0)) out.set(ch, boost);
  };
  for (const w of core) raise(w.written, w.order <= EARLY_CORE ? BOOST.early : w.order <= MID_CORE ? BOOST.mid : BOOST.late);
  for (const t of targetWords) raise(t, BOOST.early);
  return out;
}

const freqOf = (k: CurriculumKanji) => k.freq ?? MISSING_FREQ;

export function effectiveRank(k: CurriculumKanji, boosts: ReadonlyMap<string, number> = new Map()): number {
  return freqOf(k) - (boosts.get(k.char) ?? 0);
}

/** Spine order: effectiveRank, then freqRank, then codepoint. */
export function compareSpine(boosts: ReadonlyMap<string, number> = new Map()) {
  return (a: CurriculumKanji, b: CurriculumKanji): number =>
    effectiveRank(a, boosts) - effectiveRank(b, boosts) ||
    freqOf(a) - freqOf(b) ||
    a.char.codePointAt(0)! - b.char.codePointAt(0)!;
}

const USEFUL_PRI = new Set(['ichi1', 'spec1', 'spec2']);
const NEWS_PRI_RE = /^(news[12]|nf\d\d)$/;

/** JMdict's basic-vocabulary or special-common tags (ichi1, spec1, spec2). */
export const hasUsefulPriority = (w: Pick<UnitCandidate, 'pri'>) => w.pri.some((p) => USEFUL_PRI.has(p));
/** The only priority tags are newspaper ones: a word from the news, not from daily life. */
export const isNewsOnly = (w: Pick<UnitCandidate, 'pri'>) => w.pri.length > 0 && w.pri.every((p) => NEWS_PRI_RE.test(p));
/** A word worth meeting a kanji with: basic vocabulary, or a core word. */
export const isUsefulWord = (w: Pick<UnitCandidate, 'pri' | 'core' | 'target'>) => hasUsefulPriority(w) || !!w.core || !!w.target;

/** Kanji too rare to be pulled forward as a component: newspaper rank > 1000 or no useful word. */
export function rareKanji(kanji: readonly CurriculumKanji[], words: readonly UnitCandidate[]): Set<string> {
  const useful = new Set<string>();
  for (const w of words) if (isUsefulWord(w)) for (const ch of w.kanji) useful.add(ch);
  return new Set(kanji.filter((k) => freqOf(k) > RARE_FREQ || !useful.has(k.char)).map((k) => k.char));
}

const AFFIX_POS = new Set(['suf', 'pref', 'ctr', 'n-suf', 'n-pref']);
/** A gloss like "multi-" or "-ical": JMdict sometimes tags such entries as nouns too (多 た [n, pref]). */
const AFFIX_GLOSS_RE = /^-|-$/;
/** Prefixes and suffixes never stand for their kanji on their own; a counter (枚 まい) does. */
export function isBoundAffix(w: Pick<UnitCandidate, 'pos' | 'meanings'>): boolean {
  const affixOnly = (w.pos.length > 0 && w.pos.every((p) => AFFIX_POS.has(p))) || AFFIX_GLOSS_RE.test(w.meanings[0] ?? '');
  return affixOnly && !w.pos.includes('ctr');
}

/** The kanji's readings to look for inside words: on readings in hiragana and kun stems, longest first. */
export function readingsOf(k: Pick<CurriculumKanji, 'on' | 'kun'>): string[] {
  const out = new Set<string>();
  for (const r of k.on ?? []) out.add(toHiragana(r.replace(/-/g, '')));
  for (const r of k.kun ?? []) out.add(r.replace(/-/g, '').split('.')[0]);
  out.delete('');
  return [...out].sort((a, b) => b.length - a.length);
}

const KANA_RE = /^[ぁ-ゖ]*$/;

/**
 * Which of `readings` (readingsOf) the kanji has inside a word, allowing rendaku and gemination:
 * 日 in 毎日 まいにち → にち, in 日本 にほん → に… (longest match), in 休日 → じつ. Undefined when none fits.
 */
export function kanjiReadingIn(char: string, w: Pick<UnitCandidate, 'written' | 'kana'>, readings: readonly string[]): string | undefined {
  const at = w.written.indexOf(char);
  if (at < 0) return undefined;
  const kana = toHiragana(w.kana);
  const before = w.written.slice(0, at);
  const after = w.written.slice(at + char.length);
  // Only kana around the kanji: its reading is exactly what is left of the word's reading.
  if (KANA_RE.test(before) && KANA_RE.test(after) && kana.startsWith(before) && kana.endsWith(after)) {
    const own = kana.slice(before.length, kana.length - after.length);
    return readings.find((r) => soundVariants(r).includes(own) || own.startsWith(r)) ?? (own || undefined);
  }
  const trailing = /[ぁ-ゖ]*$/.exec(after)?.[0] ?? '';
  for (const r of readings) {
    for (const v of soundVariants(r)) {
      if (at === 0 ? kana.startsWith(v) : after.length === trailing.length ? kana.endsWith(v + trailing) : kana.includes(v, 1)) {
        return r;
      }
    }
  }
  return undefined;
}

/** The reading of `char` used by the most candidate words (ties: the longer, then the first in `readings`). */
export function commonReading(char: string, words: readonly UnitCandidate[], readings: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const w of words) {
    const r = kanjiReadingIn(char, w, readings);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [r, n] of counts) if (best === undefined || n > counts.get(best)!) best = r;
  return best;
}

/**
 * Score of a candidate word for a kanji unit: +3 ichi1/spec1/spec2, +3 core word or target, +2 the
 * kanji's most common reading, +1 three characters or fewer, −2 newspaper-only priority.
 */
export function scoreWord(char: string, w: UnitCandidate, common: string | undefined, readings: readonly string[]): number {
  let score = 0;
  if (hasUsefulPriority(w)) score += 3;
  if (w.core || w.target) score += 3;
  if (common !== undefined && kanjiReadingIn(char, w, readings) === common) score += 2;
  if ([...w.written].length <= 3) score += 1;
  if (isNewsOnly(w)) score -= 2;
  return score;
}

/**
 * Up to MAX_UNIT_WORDS words for a kanji from `candidates` (which already contain it and use only
 * taught kanji), best score first; ties go to useful words, then core words by teaching order
 * (人 ひと before 一人), then the lower freqRank, then the shorter word. Words whose only priority is the news are dropped unless they are core words. A
 * bare prefix or suffix never opens the list while another word exists, and a spelling already
 * picked (人 ひと / 人 じん) is skipped. `allWords` (every word with the kanji) decides its most common reading.
 */
export function pickUnitWords(
  char: string,
  candidates: readonly UnitCandidate[],
  readings: readonly string[] = [],
  allWords: readonly UnitCandidate[] = candidates,
  max = MAX_UNIT_WORDS,
): UnitCandidate[] {
  const common = commonReading(char, allWords, readings);
  const scored = candidates
    .filter((w) => !isNewsOnly(w) || w.core || w.target)
    .map((w) => ({ w, score: scoreWord(char, w, common, readings) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(isUsefulWord(b.w)) - Number(isUsefulWord(a.w)) ||
        (a.w.coreOrder ?? Infinity) - (b.w.coreOrder ?? Infinity) ||
        a.w.freqRank - b.w.freqRank ||
        [...a.w.written].length - [...b.w.written].length ||
        (a.w.ref < b.w.ref ? -1 : a.w.ref > b.w.ref ? 1 : 0),
    )
    .map((s) => s.w);
  const first = scored.find((w) => !isBoundAffix(w)) ?? scored[0];
  const picked: UnitCandidate[] = [];
  for (const w of first ? [first, ...scored] : scored) {
    if (picked.length >= max) break;
    if (!picked.some((p) => p.written === w.written || p.ref === w.ref)) picked.push(w);
  }
  return picked;
}

/**
 * The teaching order: components first (depth-first, rare ones left out), then a list schedule
 * that places the first kanji whose components are all placed and whose visual confusables are
 * ≥ CONFUSABLE_GAP positions back. A kanji held back that way is placed as soon as the gap holds.
 */
export function teachingOrder(
  spine: readonly string[],
  components: ReadonlyMap<string, readonly string[]>,
  isUnit: (ch: string) => boolean,
  rare: ReadonlySet<string>,
  visualSets: readonly (readonly string[])[] = [],
): { order: string[]; spaced: string[] } {
  const pulled = (ch: string) => (components.get(ch) ?? []).filter((c) => isUnit(c) && !rare.has(c) && c !== ch);
  const desired: string[] = [];
  const seen = new Set<string>();
  const expand = (ch: string) => {
    if (seen.has(ch)) return;
    seen.add(ch);
    for (const c of pulled(ch)) expand(c);
    desired.push(ch);
  };
  for (const ch of spine) expand(ch);

  const setsOf = new Map<string, (readonly string[])[]>();
  for (const set of visualSets) for (const ch of set) setsOf.set(ch, [...(setsOf.get(ch) ?? []), set]);
  const position = new Map<string, number>();
  const order: string[] = [];
  const held = new Set<string>();
  const remaining = [...desired];
  const componentsPlaced = (ch: string) => pulled(ch).every((c) => position.has(c));
  const spacedOut = (ch: string) =>
    (setsOf.get(ch) ?? []).every((set) =>
      set.every((m) => m === ch || !position.has(m) || order.length - position.get(m)! >= CONFUSABLE_GAP),
    );
  while (remaining.length > 0) {
    let pick = -1;
    for (let i = 0; i < remaining.length && pick < 0; i++) {
      if (!componentsPlaced(remaining[i])) continue;
      if (spacedOut(remaining[i])) pick = i;
      else held.add(remaining[i]);
    }
    // Nothing can keep its gap (the last few kanji), or components wait on each other: take the first.
    if (pick < 0) pick = Math.max(0, remaining.findIndex(componentsPlaced));
    const [ch] = remaining.splice(pick, 1);
    position.set(ch, order.length);
    order.push(ch);
  }
  return { order, spaced: [...held] };
}

/**
 * Curriculum v2: kanji units in teaching order with anchor and staged words, `inferable` and
 * `chapter`, plus each kanji's components and named parts. A kanji listed in `overrides` gets
 * exactly its listed words; an override word that cannot be used (unknown id, changed spelling, a
 * kanji taught later, already used) is reported through `warn` and its slot goes to the automatic pick.
 */
export function buildCurriculum(input: CurriculumInput): CurriculumResult {
  const kanjiByChar = new Map(input.kanji.map((k) => [k.char, k]));
  const isUnit = (ch: string) => kanjiByChar.has(ch);
  const rare = rareKanji(input.kanji, input.words);
  const spine = [...input.kanji].sort(compareSpine(input.boosts)).map((k) => k.char);
  const visual = (input.confusables ?? []).filter((s) => s.kind === 'visual').map((s) => s.chars.filter(isUnit));
  const { order, spaced } = teachingOrder(spine, input.components, isUnit, rare, visual);
  const index = new Map(order.map((ch, i) => [ch, i]));

  const components = new Map<string, string[]>();
  const parts = new Map<string, string[]>();
  for (const ch of order) {
    const own: string[] = [];
    const named: string[] = [];
    for (const c of input.components.get(ch) ?? []) {
      if (c === ch) continue;
      if (isUnit(c) && index.get(c)! < index.get(ch)!) own.push(c);
      else named.push(c);
    }
    components.set(ch, [...new Set(own)]);
    parts.set(ch, [...new Set(named)]);
  }

  const wordsByKanji = new Map<string, UnitCandidate[]>();
  for (const w of input.words) {
    for (const ch of new Set(w.kanji)) {
      const list = wordsByKanji.get(ch);
      if (list) list.push(w);
      else wordsByKanji.set(ch, [w]);
    }
  }
  const entryById = new Map<string, UnitCandidate>();
  for (const w of input.words) if (w.ref.startsWith('word:') || /^\d+$/.test(w.id)) entryById.set(w.id, w);
  const used = new Set<string>();

  const overrideProblem = (char: string, at: number, [id, written, kana]: OverrideWord, picked: readonly UnitCandidate[]) => {
    const w = entryById.get(id);
    if (!w) return 'is not a candidate (not in words.json, or a core word usually written in kana)';
    if (w.written !== written || w.kana !== kana) return `is now ${w.written} ${w.kana}`;
    if (!w.kanji.includes(char)) return `does not contain ${char}`;
    const late = w.kanji.find((c) => (index.get(c) ?? Infinity) > at);
    if (late) return `needs ${late}, which is taught later`;
    if (used.has(w.ref) || picked.some((p) => p.ref === w.ref)) return 'is already used';
    return undefined;
  };

  const units: CurriculumUnit[] = order.map((char, at) => {
    const all = wordsByKanji.get(char) ?? [];
    const override = input.overrides?.[char];
    const fixed: UnitCandidate[] = [];
    for (const word of override ?? []) {
      const problem = overrideProblem(char, at, word, fixed);
      if (problem) input.warn?.(`word override for ${char}: ${word[1]} ${word[2]} (${word[0]}) ${problem}; using the automatic pick`);
      else fixed.push(entryById.get(word[0])!);
    }
    const wanted = Math.min(override?.length ?? MAX_UNIT_WORDS, MAX_UNIT_WORDS);
    const candidates = all.filter(
      (w) =>
        !used.has(w.ref) &&
        !fixed.some((f) => f.written === w.written || f.ref === w.ref) &&
        w.kanji.every((c) => (index.get(c) ?? Infinity) <= at),
    );
    const automatic = fixed.length < wanted ? pickUnitWords(char, candidates, readingsOf(kanjiByChar.get(char)!), all, wanted - fixed.length) : [];
    const picked = [...fixed, ...automatic].slice(0, wanted);
    for (const w of picked) used.add(w.ref);
    // Every component is a kanji taught earlier or a named part, so only their number and the
    // phonetic mark decide; a repeated component (林, 品, 炎) counts each time.
    const known = Math.max((components.get(char)?.length ?? 0) + (parts.get(char)?.length ?? 0), input.componentCounts?.get(char) ?? 0);
    return {
      index: at,
      char,
      anchor: picked[0]?.ref ?? null,
      staged: picked.slice(1).map((w) => w.ref),
      inferable: known >= 2 && !input.phonetic?.has(char),
      chapter: Math.floor(at / CHAPTER_SIZE) + 1,
    };
  });

  const confusables = (input.confusables ?? []).map((s) => ({ id: s.id, chars: [...s.chars], kind: s.kind }));
  return { curriculum: { version: 2, units, confusables }, components, parts, rare, spaced };
}
