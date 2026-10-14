// Teaching order for radicals and kanji (see SPEC "curriculum.json").

import type { Curriculum, CurriculumUnit, WordEntry } from '../../src/lib/types.ts';
import type { OverrideWord } from './word-overrides.ts';

export interface CurriculumKanji {
  char: string;
  jlptOld?: number;
  freq?: number;
  grade?: number;
  strokeCount: number;
  /** KANJIDIC kun readings ('なが.い'); they identify the kanji's native word. */
  kun?: readonly string[];
}

export interface CurriculumInput {
  kanji: CurriculumKanji[];
  /** Teachable components of each kanji (jōyō kanji or radicals), in teaching order. */
  components: ReadonlyMap<string, readonly string[]>;
  radicals: ReadonlySet<string>;
  words: readonly WordEntry[];
  /** Ids of neutral-register words in JMdict's basic-vocabulary list (ichi1); see pickUnitWords. */
  coreWords?: ReadonlySet<string>;
  /** Hand-picked word lists that replace the automatic pick for some kanji (see word-overrides.ts). */
  overrides?: Readonly<Record<string, readonly OverrideWord[]>>;
  /** Reports override words that cannot be used. */
  warn?: (message: string) => void;
}

export const MAX_UNIT_WORDS = 3;
/** Number of kanji introduced by the end of each phase (phase 4 runs to the end). */
export const PHASE_KANJI = { 2: 300, 3: 800 } as const;

function jlptTier(k: CurriculumKanji): number {
  if (k.jlptOld === 4) return 0;
  if (k.jlptOld === 3) return 1;
  return 2;
}

const orMax = (n: number | undefined) => n ?? Number.MAX_SAFE_INTEGER;

/**
 * Old JLPT 4, then old JLPT 3, then everything else; inside each tier by
 * newspaper frequency, and kanji without a frequency by grade then strokes.
 */
export function compareKanjiPriority(a: CurriculumKanji, b: CurriculumKanji): number {
  return (
    jlptTier(a) - jlptTier(b) ||
    orMax(a.freq) - orMax(b.freq) ||
    orMax(a.grade) - orMax(b.grade) ||
    a.strokeCount - b.strokeCount ||
    a.char.codePointAt(0)! - b.char.codePointAt(0)!
  );
}

const AFFIX_POS = new Set(['suf', 'pref', 'ctr', 'n-suf', 'n-pref']);
/** A gloss like "multi-" or "-ical": JMdict sometimes tags such entries as nouns too (多 た [n, pref]). */
const AFFIX_GLOSS_RE = /^-|-$/;
const length = (w: WordEntry) => [...w.written].length;
/** Entries that only exist as a suffix, prefix or counter (人 じん "-ian") make poor first words. */
const affixOnly = (w: WordEntry) =>
  (w.pos.length > 0 && w.pos.every((p) => AFFIX_POS.has(p))) || AFFIX_GLOSS_RE.test(w.meanings[0] ?? '') ? 1 : 0;
/** Prefixes and suffixes never stand for their kanji on their own; a counter (枚 まい) does. */
const boundAffix = (w: WordEntry) => affixOnly(w) === 1 && !w.pos.includes('ctr');

/** Most frequent first, then shortest, then lowest JMdict id for a stable order. */
export function compareWordsForUnit(a: WordEntry, b: WordEntry): number {
  return (
    affixOnly(a) - affixOnly(b) ||
    a.freqRank - b.freqRank ||
    length(a) - length(b) ||
    Number(a.id) - Number(b.id)
  );
}

/**
 * A native word made of the kanji alone plus okurigana and read with one of its
 * kun readings: 人 (ひと), 長い (なが.い), 休む (やす.む).
 */
export function isKunWord(char: string, w: WordEntry, kun: readonly string[]): boolean {
  if (!w.written.startsWith(char)) return false;
  const okurigana = w.written.slice(char.length);
  if (!/^[ぁ-ゖ]*$/.test(okurigana)) return false;
  return kun.some((reading) => {
    const [stem, okuri = ''] = reading.split('.');
    return okuri === okurigana && stem + okuri === w.kana;
  });
}

/**
 * Up to MAX_UNIT_WORDS words for a new kanji, from candidates that contain it
 * and use only taught kanji. Mostly "most frequent first, shortest on ties",
 * with one correction for a gap in JMdict: its newspaper ranks (nfXX) are
 * missing or poor for many basic words (上 うえ, 人 ひと, 行く, 見る nf14) and
 * favour nouns over inflecting words (長さ over 長い), which would otherwise lose
 * to compounds or tagging artefacts (上がったり nf02). So the first slot goes to
 * the kanji's own basic word, if it has one: a word with no other kanji that is
 * not a bare prefix or suffix (不 "un-", 的 "-ical"), preferring core vocabulary,
 * then a native word read with one of `kun` (作る over 作 さく), then the
 * shortest. Words spelled the same as one already picked (人 ひと / 人 じん) are
 * skipped.
 */
export function pickUnitWords(
  char: string,
  candidates: readonly WordEntry[],
  coreWords: ReadonlySet<string> = new Set(),
  kun: readonly string[] = [],
): WordEntry[] {
  const notCore = (w: WordEntry) => (coreWords.has(w.id) ? 0 : 1);
  const notKun = (w: WordEntry) => (isKunWord(char, w, kun) ? 0 : 1);
  const basic = candidates
    .filter((w) => w.kanji.length === 1 && w.kanji[0] === char && !boundAffix(w))
    .sort(
      (a, b) =>
        affixOnly(a) - affixOnly(b) ||
        notCore(a) - notCore(b) ||
        notKun(a) - notKun(b) ||
        length(a) - length(b) ||
        compareWordsForUnit(a, b),
    )[0];
  const picked: WordEntry[] = basic ? [basic] : [];
  for (const w of [...candidates].sort(compareWordsForUnit)) {
    if (picked.length >= MAX_UNIT_WORDS) break;
    if (!picked.some((p) => p.written === w.written)) picked.push(w);
  }
  return picked;
}

/**
 * Units in teaching order (see SPEC). A kanji listed in `overrides` gets
 * exactly its listed words; an override word that cannot be used (unknown id,
 * changed spelling, a kanji taught later, already used) is reported through
 * `warn` and its slot goes to the automatic pick.
 */
export function buildCurriculum(input: CurriculumInput): Curriculum {
  const kanjiSet = new Set(input.kanji.map((k) => k.char));
  const kunOf = new Map(input.kanji.map((k) => [k.char, k.kun ?? []]));
  const wordById = new Map(input.words.map((w) => [w.id, w]));
  const wordsByKanji = new Map<string, WordEntry[]>();
  for (const w of input.words) {
    for (const ch of w.kanji) {
      let list = wordsByKanji.get(ch);
      if (!list) wordsByKanji.set(ch, (list = []));
      list.push(w);
    }
  }

  const units: CurriculumUnit[] = [];
  const taught = new Set<string>();
  const usedWords = new Set<string>();
  const inProgress = new Set<string>();

  const overrideProblem = (char: string, [id, written, kana]: OverrideWord, picked: readonly WordEntry[]) => {
    const w = wordById.get(id);
    if (!w) return 'is not in words.json';
    if (w.written !== written || w.kana !== kana) return `is now ${w.written} ${w.kana}`;
    if (!w.kanji.includes(char)) return `does not contain ${char}`;
    const late = w.kanji.find((c) => !taught.has(c));
    if (late) return `needs ${late}, which is taught later`;
    if (usedWords.has(id) || picked.includes(w)) return 'is already used';
    return undefined;
  };

  const overrideWords = (char: string, list: readonly OverrideWord[]): WordEntry[] => {
    const picked: WordEntry[] = [];
    for (const word of list) {
      const problem = overrideProblem(char, word, picked);
      if (problem) input.warn?.(`word override for ${char}: ${word[1]} ${word[2]} (${word[0]}) ${problem}; using the automatic pick`);
      else picked.push(wordById.get(word[0])!);
    }
    return picked;
  };

  const unitWords = (char: string): string[] => {
    const override = input.overrides?.[char];
    const fixed = override ? overrideWords(char, override) : [];
    const wanted = Math.min(override?.length ?? MAX_UNIT_WORDS, MAX_UNIT_WORDS);
    const candidates = (wordsByKanji.get(char) ?? []).filter(
      (w) =>
        !usedWords.has(w.id) && !fixed.some((f) => f.written === w.written) && w.kanji.every((c) => taught.has(c)),
    );
    const automatic = fixed.length < wanted ? pickUnitWords(char, candidates, input.coreWords, kunOf.get(char)) : [];
    const picked = [...fixed, ...automatic].slice(0, wanted).map((w) => w.id);
    for (const id of picked) usedWords.add(id);
    return picked;
  };

  const teachKanji = (char: string) => {
    if (taught.has(char) || inProgress.has(char)) return;
    inProgress.add(char);
    for (const c of input.components.get(char) ?? []) {
      if (kanjiSet.has(c)) teachKanji(c);
      else if (input.radicals.has(c) && !taught.has(c)) {
        taught.add(c);
        units.push({ index: units.length, type: 'radical', char: c, words: [], phase: 0 });
      }
    }
    inProgress.delete(char);
    taught.add(char);
    units.push({ index: units.length, type: 'kanji', char, words: unitWords(char), phase: 0 });
  };

  for (const k of [...input.kanji].sort(compareKanjiPriority)) teachKanji(k.char);

  const phaseEnds = computePhaseEnds(units);
  for (const u of units) u.phase = u.index < phaseEnds['2'] ? 2 : u.index < phaseEnds['3'] ? 3 : 4;
  return { units, phaseEnds };
}

/** Exclusive end index of each phase: the unit that introduces the Nth kanji, plus one. */
export function computePhaseEnds(units: readonly CurriculumUnit[]): Record<string, number> {
  const ends: Record<string, number> = {};
  let kanjiCount = 0;
  for (const u of units) {
    if (u.type !== 'kanji') continue;
    kanjiCount++;
    if (kanjiCount === PHASE_KANJI[2]) ends['2'] = u.index + 1;
    if (kanjiCount === PHASE_KANJI[3]) ends['3'] = u.index + 1;
  }
  ends['2'] ??= units.length;
  ends['3'] ??= units.length;
  ends['4'] = units.length;
  return ends;
}
