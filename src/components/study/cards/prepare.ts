// Loads what a review card shows and picks its answer options.

import { db, getSettings } from '../../../lib/db.ts';
import {
  loadCurriculum,
  loadGrammar,
  loadKana,
  loadKanji,
  loadRadicals,
  loadSurvivalWords,
  loadWordIndex,
  loadWords,
} from '../../../lib/data.ts';
import { isKanji } from '../../../lib/ruby.ts';
import type { CardRecord, Curriculum, ItemKind, KanjiEntry, WordEntry } from '../../../lib/types.ts';
import { choicesFrom, normalizeMeaning, shuffle, toHiragana } from '../../../srs/answers.ts';
import { knownKanaSet, requiredKana } from '../../../srs/course.ts';
import { isYoon } from '../../../srs/items.ts';
import { cleanReading, sharedSoundRow } from '../format.ts';
import { sentencesById } from '../sentences.ts';
import type { BreakdownPart, PreparedCard } from './types.ts';

export const OPTION_COUNT = 4;
/** Kanji this many curriculum units either side count as "similar level". */
const LEVEL_WINDOW = 15;
/** Words up to this JMdict rank are common enough to make fair distractors. */
const COMMON_RANK = 30;
/** Words up to this rank are everyday words, fair as English distractors for a beginner. */
const EVERYDAY_RANK = 5;
/** Kana that are also particles, said differently then: は "wa", へ "e", を "o". */
const PARTICLE_SOUND: Record<string, string> = { は: 'wa', へ: 'e', を: 'o' };

type Random = () => number;

/**
 * Distractors taken from the first tier first (in random order), then the next
 * tiers, all distinct by `key` and never equal to an excluded key.
 */
function distractors<T>(tiers: readonly (readonly T[])[], key: (item: T) => string, exclude: Iterable<string>, random: Random): T[] {
  const out: T[] = [];
  const seen = new Set(exclude);
  for (const tier of tiers) {
    for (const item of shuffle(tier, random)) {
      if (out.length >= OPTION_COUNT - 1) return out;
      const k = key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

function options(correct: string, tiers: readonly (readonly string[])[], random: Random, exclude: Iterable<string> = [], key = (s: string) => s): string[] {
  return choicesFrom(correct, distractors(tiers, key, [key(correct), ...exclude], random), OPTION_COUNT, key, random);
}

async function introducedKeys(kind: ItemKind): Promise<Set<string>> {
  const ids = await db.items.where('kind').equals(kind).primaryKeys();
  return new Set(ids.map((id) => String(id).slice(kind.length + 1)));
}

const kanaLength = (s: string) => [...s].length;

/** Each kanji of a word with its meaning; empty for a one-character word, which needs no breakdown. */
export function breakdownOf(written: string, kanji: Record<string, KanjiEntry>): BreakdownPart[] {
  if ([...written].length < 2) return [];
  return [...new Set([...written].filter(isKanji))].map((char) => ({ char, meaning: kanji[char]?.meanings[0] }));
}

/** Kanji units nearest to `char` in the curriculum, nearest first. */
async function sameLevelKanji(char: string, kanji: Record<string, KanjiEntry>): Promise<KanjiEntry[]> {
  const units = (await loadCurriculum()).units.filter((u) => u.type === 'kanji');
  const at = units.findIndex((u) => u.char === char);
  if (at < 0) return [];
  return units
    .slice(Math.max(0, at - LEVEL_WINDOW), at + LEVEL_WINDOW + 1)
    .filter((u) => u.char !== char)
    .flatMap((u) => (kanji[u.char] ? [kanji[u.char]] : []));
}

/**
 * Kana options for a reading: readings of common words of about the same
 * length, those sharing a kanji with the answer's word first. Words written
 * like the answer are left out (they would be a second right answer).
 */
export async function readingOptions(
  answer: string,
  { kanji = [], written, exclude = [] }: {
    kanji?: readonly string[];
    written?: string;
    /** Readings that must not be offered either, e.g. the answer with or without its okurigana. */
    exclude?: readonly string[];
  },
  random: Random = Math.random,
): Promise<string[]> {
  const words = await loadWords();
  const len = kanaLength(answer);
  const near = (w: WordEntry) => Math.abs(kanaLength(w.kana) - len) <= 1 && w.written !== written;
  const common = words.filter((w) => w.freqRank <= COMMON_RANK && near(w));
  const related = kanji.length ? common.filter((w) => w.kanji.some((k) => kanji.includes(k))) : [];
  const sameLength = common.filter((w) => kanaLength(w.kana) === len);
  const tiers = [related.slice(0, 40), sameLength, common].map((tier) => tier.map((w) => w.kana));
  return options(answer, tiers, random, exclude.map(toHiragana), toHiragana);
}

/** Meaning options; candidates sharing any meaning with the answer are left out. */
export function meaningOptions(meanings: readonly string[], candidates: readonly (readonly string[])[][], random: Random = Math.random): string[] {
  const own = new Set(meanings.map(normalizeMeaning));
  const fair = (ms: readonly string[]) => !ms.some((m) => own.has(normalizeMeaning(m)));
  const tiers = candidates.map((tier) => tier.filter(fair).map((ms) => ms[0]));
  return options(meanings[0], tiers, random, own, normalizeMeaning);
}

/** The reading shown with a kanji's write prompt: a one-kanji word, else a kun reading, else on. */
export function writePromptReading(kanji: KanjiEntry, words: readonly WordEntry[]): string {
  const single = words.find((w) => w.written === kanji.char);
  if (single) return single.kana;
  if (kanji.kun.length) return cleanReading(kanji.kun[0]);
  return kanji.on[0] ?? '';
}

/** Introduced words written with this kanji. */
async function taughtWords(char: string): Promise<WordEntry[]> {
  const [keys, index] = await Promise.all([introducedKeys('word'), loadWordIndex()]);
  return [...keys].flatMap((id) => {
    const w = index.get(id);
    return w && w.kanji.includes(char) ? [w] : [];
  });
}

function pick<T>(items: readonly T[], random: Random): T | undefined {
  return items.length ? items[Math.floor(random() * items.length)] : undefined;
}

/**
 * Meanings a typed answer for this kanji must not be taken as a typo of: every
 * other kanji's meanings ("block" is 町, so it can't pass for "black"), except
 * meanings this kanji shares.
 */
export function otherKanjiMeanings(entry: KanjiEntry, kanji: Record<string, KanjiEntry>): string[] {
  const own = new Set(entry.meanings.map(normalizeMeaning));
  const out = new Set<string>();
  for (const k of Object.values(kanji)) {
    if (k.char === entry.char) continue;
    for (const m of k.meanings) if (!own.has(normalizeMeaning(m))) out.add(m);
  }
  return [...out];
}

/** Words taught with the curriculum units near this word's unit (its level), nearest first. */
function sameLevelWords(id: string, curriculum: Curriculum, index: ReadonlyMap<string, WordEntry>): WordEntry[] {
  const units = curriculum.units;
  const at = units.findIndex((u) => u.words?.includes(id));
  if (at < 0) return [];
  return units
    .slice(Math.max(0, at - LEVEL_WINDOW), at + LEVEL_WINDOW + 1)
    .flatMap((u) => u.words ?? [])
    .flatMap((w) => (w !== id && index.get(w) ? [index.get(w)!] : []));
}

/** Kana the learner can read: introduced, or a whole script they said they know. */
async function readableKana(): Promise<{ course: Set<string>; known: Set<string> }> {
  const [kana, settings, introduced] = await Promise.all([
    loadKana(),
    getSettings(),
    db.items.where('kind').equals('kana').primaryKeys(),
  ]);
  return {
    course: new Set(kana.map((k) => k.char)),
    known: knownKanaSet({ kana, introduced: new Set(introduced.map(String)), ...settings }),
  };
}

/** Context for a card shown as part of a block (a session's reviews, the first check). */
export interface PrepareContext {
  /** Every card id in the block, so two cards don't ask the same question. */
  block?: readonly string[];
}

const WORD_READING = /^word:(.+)\|reading$/;

/** Card content with answer options; null when its data is missing. */
export async function prepareCard(card: CardRecord, random: Random = Math.random, context: PrepareContext = {}): Promise<PreparedCard | null> {
  const key = card.itemId.slice(card.kind.length + 1);

  switch (card.kind) {
    case 'kana': {
      const all = await loadKana();
      const kana = all.find((k) => k.char === key);
      if (!kana) return null;
      if (card.type === 'write') return { view: 'kana-write', card, kana, row: sharedSoundRow(kana, all) };
      const known = await introducedKeys('kana');
      const peers = all.filter((k) => k.script === kana.script && isYoon(k.char) === isYoon(kana.char));
      // を is also read "o": お's romaji would be a second right answer. Likewise は and へ
      // are read "wa" and "e" as particles, as the grammar lessons teach, so those are never wrong options.
      const alsoRight = [...(kana.altRomaji ?? []), ...(PARTICLE_SOUND[kana.char] ? [PARTICLE_SOUND[kana.char]] : [])];
      const romaji = options(kana.romaji, [peers.filter((k) => known.has(k.char)).map((k) => k.romaji), peers.map((k) => k.romaji)], random, alsoRight);
      return { view: 'kana-read', card, kana, options: romaji };
    }

    case 'radical': {
      const radicals = await loadRadicals();
      const radical = radicals.find((r) => r.char === key);
      if (!radical) return null;
      const others = radicals.filter((r) => r.char !== key).map((r) => [r.meaning]);
      return { view: 'radical-meaning', card, radical, options: meaningOptions([radical.meaning], [others], random) };
    }

    case 'kanji': {
      const kanji = await loadKanji();
      const entry = kanji[key];
      if (!entry) return null;
      if (card.type === 'meaning') {
        const level = await sameLevelKanji(key, kanji);
        const opts = meaningOptions(entry.meanings, [level.map((k) => k.meanings), Object.values(kanji).map((k) => k.meanings)], random);
        return { view: 'kanji-meaning', card, kanji: entry, options: opts, notAccepted: otherKanjiMeanings(entry, kanji) };
      }
      const words = await taughtWords(key);
      if (card.type === 'write') return { view: 'kanji-write', card, kanji: entry, reading: writePromptReading(entry, words) };

      // A word whose own reading card is in the same block would be the same question twice.
      const asked = new Set((context.block ?? []).flatMap((id) => WORD_READING.exec(id)?.[1] ?? []));
      const word = pick(words.filter((w) => !asked.has(w.id)), random);
      if (word) {
        const opts = await readingOptions(word.kana, word, random);
        return { view: 'kanji-reading', card, kanji: entry, word, answer: word.kana, options: opts, breakdown: breakdownOf(word.written, kanji) };
      }
      // No taught word to show (none yet, or all asked about already): ask for one of the
      // kanji's own readings, one the block's word cards don't ask when there is one.
      const own = [...new Set([...entry.kun.map(cleanReading), ...entry.on.map(toHiragana)])];
      const askedKana = new Set(words.map((w) => toHiragana(w.kana)));
      const answer = own.find((r) => !askedKana.has(r)) ?? own[0];
      if (!answer) return null;
      const level = await sameLevelKanji(key, kanji);
      const others = level.flatMap((k) => [...k.kun.map(cleanReading), ...k.on.map(toHiragana)]);
      const opts = options(answer, [others], random, own);
      return { view: 'kanji-reading', card, kanji: entry, answer, options: opts, breakdown: [] };
    }

    case 'word': {
      const [index, kanji] = await Promise.all([loadWordIndex(), loadKanji()]);
      const word = index.get(key);
      if (!word) return null;
      const breakdown = breakdownOf(word.written, kanji);
      if (card.type === 'reading') {
        return { view: 'word-reading', card, word, options: await readingOptions(word.kana, word, random), breakdown };
      }
      // English options at the learner's level: words already taught, then words taught
      // around this one in the course, then everyday words (never "centrifugal force").
      const [words, curriculum, taught] = await Promise.all([loadWords(), loadCurriculum(), introducedKeys('word')]);
      const others = (list: readonly WordEntry[]) => list.filter((w) => w.id !== word.id);
      const taughtWords = others([...taught].flatMap((id) => index.get(id) ?? []));
      const level = sameLevelWords(word.id, curriculum, index);
      const everyday = others(words.filter((w) => w.freqRank <= EVERYDAY_RANK));
      const samePos = (list: readonly WordEntry[]) => list.filter((w) => w.pos[0] === word.pos[0]);
      const tiers = [samePos(taughtWords), taughtWords, samePos(level), level, samePos(everyday), everyday];
      const opts = meaningOptions(word.meanings, tiers.map((tier) => tier.map((w) => w.meanings)), random);
      return { view: 'word-meaning', card, word, options: opts, breakdown };
    }

    case 'vocab': {
      const survival = await loadSurvivalWords();
      const vocab = survival.find((w) => w.id === key);
      if (!vocab) return null;
      const others = survival.filter((w) => w.id !== key);
      if (card.type === 'recall') {
        // Options the learner can read, so the answer can't be found by spotting the only familiar kana.
        const { course, known } = await readableKana();
        const canRead = (kana: string) => requiredKana(kana, course).every((k) => known.has(k));
        const readable = others.filter((w) => canRead(w.kana));
        // Early on few survival words use only those kana (just いいえ with あいうえ), so common
        // words that do come next (あい, うえ, いう …), leaving out any that mean the same as the answer.
        const own = new Set(vocab.en.split(/[;,]/).map(normalizeMeaning));
        const words = await loadWords();
        const clash = new Set(words.filter((w) => w.meanings.some((m) => own.has(normalizeMeaning(m)))).map((w) => w.kana));
        const readableWords = words.filter((w) => w.freqRank <= COMMON_RANK && !clash.has(w.kana) && canRead(w.kana));
        const len = kanaLength(vocab.kana);
        const near = (list: readonly { kana: string }[]) => list.filter((w) => Math.abs(kanaLength(w.kana) - len) <= 1).map((w) => w.kana);
        const tiers = [near(readable), readable.map((w) => w.kana), near(readableWords), readableWords.map((w) => w.kana), near(others), others.map((w) => w.kana)];
        return { view: 'vocab-recall', card, vocab, options: options(vocab.kana, tiers, random) };
      }
      return { view: 'vocab-meaning', card, vocab, options: meaningOptions([vocab.en], [others.map((w) => [w.en])], random) };
    }

    case 'grammar': {
      const point = (await loadGrammar()).find((g) => g.id === key);
      const drill = point && pick(point.drills, random);
      if (!point || !drill) return null;
      return { view: 'grammar-drill', card, point, drill, options: shuffle(drill.options, random) };
    }

    case 'sentence': {
      const [sentence] = await sentencesById([key]);
      return sentence ? { view: 'sentence-read', card, sentence } : null;
    }
  }
}
