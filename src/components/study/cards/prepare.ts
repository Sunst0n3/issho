// Loads what a review card shows and picks its answer options.

import { db } from '../../../lib/db.ts';
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
import type { CardRecord, ItemKind, KanjiEntry, WordEntry } from '../../../lib/types.ts';
import { choicesFrom, normalizeMeaning, shuffle, toHiragana } from '../../../srs/answers.ts';
import { isYoon } from '../../../srs/items.ts';
import { cleanReading, sharedSoundRow } from '../format.ts';
import { sentencesById } from '../sentences.ts';
import type { BreakdownPart, PreparedCard } from './types.ts';

export const OPTION_COUNT = 4;
/** Kanji this many curriculum units either side count as "similar level". */
const LEVEL_WINDOW = 15;
/** Words up to this JMdict rank are common enough to make fair distractors. */
const COMMON_RANK = 30;

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
  { kanji = [], written }: { kanji?: readonly string[]; written?: string },
  random: Random = Math.random,
): Promise<string[]> {
  const words = await loadWords();
  const len = kanaLength(answer);
  const near = (w: WordEntry) => Math.abs(kanaLength(w.kana) - len) <= 1 && w.written !== written;
  const common = words.filter((w) => w.freqRank <= COMMON_RANK && near(w));
  const related = kanji.length ? common.filter((w) => w.kanji.some((k) => kanji.includes(k))) : [];
  const sameLength = common.filter((w) => kanaLength(w.kana) === len);
  const tiers = [related.slice(0, 40), sameLength, common].map((tier) => tier.map((w) => w.kana));
  return options(answer, tiers, random, [], toHiragana);
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

/** Card content with answer options; null when its data is missing. */
export async function prepareCard(card: CardRecord, random: Random = Math.random): Promise<PreparedCard | null> {
  const key = card.itemId.slice(card.kind.length + 1);

  switch (card.kind) {
    case 'kana': {
      const all = await loadKana();
      const kana = all.find((k) => k.char === key);
      if (!kana) return null;
      if (card.type === 'write') return { view: 'kana-write', card, kana, row: sharedSoundRow(kana, all) };
      const known = await introducedKeys('kana');
      const peers = all.filter((k) => k.script === kana.script && isYoon(k.char) === isYoon(kana.char));
      // を is also read "o": お's romaji would be a second right answer.
      const romaji = options(kana.romaji, [peers.filter((k) => known.has(k.char)).map((k) => k.romaji), peers.map((k) => k.romaji)], random, kana.altRomaji);
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
        return { view: 'kanji-meaning', card, kanji: entry, options: opts, notAccepted: opts.filter((o) => o !== entry.meanings[0]) };
      }
      const words = await taughtWords(key);
      if (card.type === 'write') return { view: 'kanji-write', card, kanji: entry, reading: writePromptReading(entry, words) };

      const word = pick(words, random);
      if (word) {
        const opts = await readingOptions(word.kana, word, random);
        return { view: 'kanji-reading', card, kanji: entry, word, answer: word.kana, options: opts, breakdown: breakdownOf(word.written, kanji) };
      }
      // No taught word yet: ask for one of the kanji's own readings.
      const own = [...entry.kun.map(cleanReading), ...entry.on.map(toHiragana)];
      const answer = own[0];
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
      const words = await loadWords();
      const common = words.filter((w) => w.id !== word.id && w.freqRank <= COMMON_RANK);
      const samePos = common.filter((w) => w.pos[0] === word.pos[0]);
      const opts = meaningOptions(word.meanings, [samePos.map((w) => w.meanings), common.map((w) => w.meanings)], random);
      return { view: 'word-meaning', card, word, options: opts, breakdown };
    }

    case 'vocab': {
      const survival = await loadSurvivalWords();
      const vocab = survival.find((w) => w.id === key);
      if (!vocab) return null;
      const others = survival.filter((w) => w.id !== key);
      if (card.type === 'recall') {
        const len = kanaLength(vocab.kana);
        const near = others.filter((w) => Math.abs(kanaLength(w.kana) - len) <= 1).map((w) => w.kana);
        return { view: 'vocab-recall', card, vocab, options: options(vocab.kana, [near, others.map((w) => w.kana)], random) };
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
