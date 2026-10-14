// What each new-item lesson shows, loaded from the static data.

import { db } from '../../../lib/db.ts';
import {
  loadCurriculum,
  loadGrammar,
  loadKana,
  loadKanaExamples,
  loadKanji,
  loadMnemonics,
  loadRadicals,
  loadSurvivalWords,
  loadWordIndex,
  loadWords,
} from '../../../lib/data.ts';
import { rubyToPlain } from '../../../lib/ruby.ts';
import type { GrammarPoint, KanaEntry, KanjiEntry, RadicalEntry, SurvivalWord, WordEntry } from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';

export interface ExampleWord {
  kana: string;
  /** The usual kanji spelling, if any. */
  written?: string;
  en: string;
}

export type LessonData =
  | { kind: 'kanji'; kanji: KanjiEntry; words: WordEntry[]; mnemonic?: string; kana: KanaEntry[] }
  | { kind: 'radical'; radical: RadicalEntry; examples: KanjiEntry[]; mnemonic?: string }
  | { kind: 'kana'; kana: KanaEntry; example?: ExampleWord; all: KanaEntry[] }
  | { kind: 'vocab'; vocab: SurvivalWord; kana: KanaEntry[] }
  | { kind: 'grammar'; point: GrammarPoint };

/** How a learned item appears in the session summary: the character and a word of meaning. */
export interface LearnedLabel {
  itemId: string;
  text: string;
  lang?: 'ja';
  meaning?: string;
}

const EXAMPLES_PER_RADICAL = 3;
const EXAMPLE_MAX_LENGTH = 5;

/** Kanji containing the radical: ones already learned first, then in teaching order. */
async function radicalExamples(char: string): Promise<KanjiEntry[]> {
  const [curriculum, kanji, known] = await Promise.all([
    loadCurriculum(),
    loadKanji(),
    db.items.where('kind').equals('kanji').primaryKeys(),
  ]);
  const knownSet = new Set(known.map((id) => String(id).slice('kanji:'.length)));
  const using = curriculum.units
    .filter((u) => u.type === 'kanji' && kanji[u.char]?.components.includes(char))
    .map((u) => kanji[u.char]);
  return [...using.filter((k) => knownSet.has(k.char)), ...using.filter((k) => !knownSet.has(k.char))].slice(0, EXAMPLES_PER_RADICAL);
}

/**
 * Whether `word` uses `char` on its own: か in かさ, but not き in きゅう (a
 * yōon) or フ in ファ. A yōon `char` is matched as a whole.
 */
export function usesKana(word: string, char: string): boolean {
  let at = word.indexOf(char);
  while (at >= 0) {
    if ([...char].length > 1 || !/^[ゃゅょャュョぁぃぅぇぉァィゥェォ]/.test(word.slice(at + char.length))) return true;
    at = word.indexOf(char, at + 1);
  }
  return false;
}

/** A short everyday word with this kana (not only inside a yōon), preferring words that start with it. */
async function searchedKanaExample(kana: KanaEntry): Promise<ExampleWord | undefined> {
  const starts = (s: string) => (s.startsWith(kana.char) ? 0 : 1);
  const best = <T extends { kana: string }>(list: T[], rank: (w: T) => number) =>
    list
      .filter((w) => usesKana(w.kana, kana.char) && [...w.kana].length <= EXAMPLE_MAX_LENGTH)
      .sort((a, b) => starts(a.kana) - starts(b.kana) || rank(a) - rank(b))[0];

  const survival = best(await loadSurvivalWords(), (w) => [...w.kana].length);
  if (survival) return { kana: survival.kana, en: survival.en };
  // Katakana mostly appears in loanwords written in kana.
  const words = (await loadWords()).filter((w) => w.written === w.kana && w.freqRank <= 30);
  const word = best(words, (w) => w.freqRank);
  return word && { kana: word.kana, en: word.meanings[0] };
}

/**
 * The example word on a kana's learn card: the hand-picked one from
 * kana-examples.json, else a word found in the survival words and the dictionary.
 */
export async function kanaExample(kana: KanaEntry): Promise<ExampleWord | undefined> {
  try {
    const picked = (await loadKanaExamples())[kana.char];
    if (picked) return { kana: picked.kana, ...(picked.written ? { written: picked.written } : {}), en: picked.en };
  } catch {
    // An older offline copy may not have the file yet: search for a word instead.
  }
  return searchedKanaExample(kana);
}

/** The lesson content for a planned item; null when its data is missing. */
export async function loadLesson(plan: NewItemPlan): Promise<LessonData | null> {
  switch (plan.kind) {
    case 'kanji': {
      const [kanji, index, mnemonics, kana] = await Promise.all([loadKanji(), loadWordIndex(), loadMnemonics(), loadKana()]);
      const entry = kanji[plan.key];
      if (!entry) return null;
      const words = (plan.words ?? []).flatMap((id) => index.get(id) ?? []);
      return { kind: 'kanji', kanji: entry, words, mnemonic: mnemonics[plan.key], kana };
    }
    case 'radical': {
      const [radicals, mnemonics] = await Promise.all([loadRadicals(), loadMnemonics()]);
      const radical = radicals.find((r) => r.char === plan.key);
      return radical
        ? { kind: 'radical', radical, examples: await radicalExamples(plan.key), mnemonic: mnemonics[plan.key] }
        : null;
    }
    case 'kana': {
      const all = await loadKana();
      const kana = all.find((k) => k.char === plan.key);
      return kana ? { kind: 'kana', kana, example: await kanaExample(kana), all } : null;
    }
    case 'vocab': {
      const [survival, kana] = await Promise.all([loadSurvivalWords(), loadKana()]);
      const vocab = survival.find((w) => w.id === plan.key);
      return vocab ? { kind: 'vocab', vocab, kana } : null;
    }
    case 'grammar': {
      const point = (await loadGrammar()).find((g) => g.id === plan.key);
      return point ? { kind: 'grammar', point } : null;
    }
  }
}

const vocabGloss = (vocab: SurvivalWord) => vocab.en.split(/[;,(]/)[0].trim();

export function lessonLabel(itemId: string, data: LessonData): LearnedLabel {
  switch (data.kind) {
    case 'kanji': return { itemId, text: data.kanji.char, lang: 'ja', meaning: data.kanji.meanings[0] };
    case 'radical': return { itemId, text: data.radical.char, lang: 'ja', meaning: data.radical.meaning };
    case 'kana': return { itemId, text: data.kana.char, lang: 'ja', meaning: data.kana.romaji };
    case 'vocab': return { itemId, text: data.vocab.kana, lang: 'ja', meaning: vocabGloss(data.vocab) };
    case 'grammar': return { itemId, text: rubyToPlain(data.point.pattern), lang: 'ja', meaning: 'grammar' };
  }
}

/**
 * Summary labels for items by id ('kanji:水'), in the order given. Words and
 * saved sentences (which come along with other things) and unknown items are left out.
 */
export async function learnedLabels(itemIds: readonly string[]): Promise<LearnedLabel[]> {
  const [kanji, radicals, kana, survival, grammar] = await Promise.all([
    loadKanji(), loadRadicals(), loadKana(), loadSurvivalWords(), loadGrammar(),
  ]);
  return itemIds.flatMap((itemId): LearnedLabel[] => {
    const at = itemId.indexOf(':');
    const kind = itemId.slice(0, at);
    const key = itemId.slice(at + 1);
    let label: LearnedLabel | undefined;
    if (kind === 'kanji' && kanji[key]) label = lessonLabel(itemId, { kind, kanji: kanji[key], words: [], kana: [] });
    const radical = kind === 'radical' ? radicals.find((r) => r.char === key) : undefined;
    if (radical) label = lessonLabel(itemId, { kind: 'radical', radical, examples: [] });
    const k = kind === 'kana' ? kana.find((e) => e.char === key) : undefined;
    if (k) label = lessonLabel(itemId, { kind: 'kana', kana: k, all: [] });
    const vocab = kind === 'vocab' ? survival.find((w) => w.id === key) : undefined;
    if (vocab) label = lessonLabel(itemId, { kind: 'vocab', vocab, kana: [] });
    const point = kind === 'grammar' ? grammar.find((g) => g.id === key) : undefined;
    if (point) label = lessonLabel(itemId, { kind: 'grammar', point });
    return label ? [label] : [];
  });
}
