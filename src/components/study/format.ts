// Small text helpers for the study screens.

import { rubyToPlain } from '../../lib/ruby.ts';
import type { GrammarPoint, KanaEntry } from '../../lib/types.ts';
import { toHiragana } from '../../srs/answers.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 10 minutes", "in 3 hours", "tomorrow", "in 4 days", "in 2 months". */
export function untilText(due: Date, now: Date = new Date()): string {
  const ms = Math.max(0, due.getTime() - now.getTime());
  if (ms < 1.5 * MINUTE) return 'in a minute';
  if (ms < HOUR) return `in ${Math.round(ms / MINUTE)} minutes`;
  if (ms < 1.5 * HOUR) return 'in an hour';
  if (ms < 20 * HOUR) return `in ${Math.round(ms / HOUR)} hours`;
  const days = Math.max(1, Math.round(ms / DAY));
  if (days === 1) return 'tomorrow';
  if (days < 45) return `in ${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 12) return `in ${months} months`;
  const years = Math.round(days / 365);
  return years <= 1 ? 'in a year' : `in ${years} years`;
}

/**
 * Compact interval for self-grade buttons: "1m", "6h", "1d", "12d", "3mo", "1y".
 * Units step up once the rounded number reaches the next unit (59.6 min is "1h", 23.6 h is "1d").
 */
export function shortInterval(due: Date, now: Date = new Date()): string {
  const ms = Math.max(0, due.getTime() - now.getTime());
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / HOUR);
  if (hours < 24) return `${hours}h`;
  const days = Math.max(1, Math.round(ms / DAY));
  if (days < 45) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30.4)}mo`;
  return `${Math.round(days / 365)}y`;
}

/** A KANJIDIC reading without okurigana dots or affix dashes: 'た.べる' → 'たべる', '-び' → 'び'. */
export function cleanReading(reading: string): string {
  return reading.replace(/[.\-]/g, '');
}

const SMALL_VOWEL: Record<string, string> = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };

/**
 * Sounds the course table doesn't have: ゔ, and the extended combinations
 * loanwords use (ファ, ティ, ウィ, ジェ …). Hiragana, as compared.
 */
const EXTRA_ROMAJI: Record<string, string> = {
  ゔ: 'vu', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
  てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  しぇ: 'she', じぇ: 'je', ちぇ: 'che', つぁ: 'tsa', つぇ: 'tse', つぉ: 'tso',
};

/** How the particles は, へ and を are said: "wa", "e", "o". */
const PARTICLE_ROMAJI: Record<string, string> = { は: 'wa', へ: 'e', を: 'o' };
/** Where a word ends: the end of the text, a space or punctuation. */
const WORD_BREAK = /^[\s、。・,.!?！？「」…]?$/u;

export interface RomajiOptions {
  /**
   * The text is a word or phrase, not a reading: a は or へ that ends a word
   * of three or more kana is the particle (こんにちは → "konnichiwa",
   * トイレは どこ → "toire wa doko"), and を is always "o". Off for kanji
   * readings, where は is "ha".
   */
  particles?: boolean;
}

/** Romaji from the kana course table, for showing readings to beginners. */
export function kanaToRomaji(text: string, kana: readonly KanaEntry[], { particles = false }: RomajiOptions = {}): string {
  const table = new Map<string, string>(Object.entries(EXTRA_ROMAJI));
  for (const k of kana) table.set(toHiragana(k.char), k.romaji);
  const chars = [...toHiragana(cleanReading(text))];
  let out = '';
  let double = false;
  /** Kana since the last space or punctuation, to tell a particle from the start of a word. */
  let wordLength = 0;
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] ?? '');
    let romaji: string | undefined;
    if (particles && PARTICLE_ROMAJI[chars[i]] && (chars[i] === 'を' || (wordLength >= 2 && WORD_BREAK.test(chars[i + 1] ?? '')))) {
      romaji = PARTICLE_ROMAJI[chars[i]];
      // A particle ends its word: "toire wa doko".
      if (chars[i + 1] === ' ' && out && !out.endsWith(' ')) out += ' ';
    } else if (table.has(pair)) {
      romaji = table.get(pair);
      if (pair.length > 1) i++;
    } else if (chars[i] === 'っ') {
      double = true;
      wordLength++;
      continue;
    } else if (chars[i] === 'ー') {
      romaji = out.at(-1) ?? '';
    } else {
      romaji = table.get(chars[i]) ?? SMALL_VOWEL[chars[i]] ?? chars[i];
    }
    if (double && romaji) {
      out += /^[a-z]/.test(romaji) && !/^[aiueo]/.test(romaji) ? (romaji.startsWith('ch') ? 't' : romaji[0]) : 't';
      double = false;
    }
    wordLength = WORD_BREAK.test(chars[i]) ? 0 : wordLength + 1;
    out += romaji;
  }
  // A small っ at the end (the ON reading ジッ) is a stop before the next word's sound: "jit".
  if (double) out += 't';
  return out;
}

/**
 * The row (its first kana, e.g. 'だ') to name alongside a kana's romaji when
 * another kana of the same script has that romaji too: "ji" is じ in the ざ
 * row and ぢ in the だ row. Undefined when the romaji alone is enough.
 */
export function sharedSoundRow(kana: KanaEntry, all: readonly KanaEntry[]): string | undefined {
  const sameScript = all.filter((k) => k.script === kana.script);
  if (!sameScript.some((k) => k.char !== kana.char && k.romaji === kana.romaji)) return undefined;
  return sameScript.filter((k) => k.group === kana.group).sort((a, b) => a.order - b.order)[0]?.char;
}

const VOWEL_ROWS: [string, string][] = [
  ['あ', 'あかさたなはまやらわがざだばぱぁゃゎ'],
  ['い', 'いきしちにひみりぎじぢびぴぃ'],
  ['う', 'うくすつぬふむゆるぐずづぶぷぅゅゔ'],
  ['え', 'えけせてねへめれげぜでべぺぇ'],
  ['お', 'おこそとのほもよろをごぞどぼぽぉょ'],
];

/**
 * A reading with each long-vowel mark written out as its vowel, the way it is
 * typed in romaji: コーヒー → こおひい ("koohii").
 */
export function longVowelsSpelledOut(kana: string): string {
  let out = '';
  for (const ch of toHiragana(kana)) {
    const before = out.at(-1);
    out += ch === 'ー' && before ? VOWEL_ROWS.find(([, row]) => row.includes(before))?.[0] ?? ch : ch;
  }
  return out;
}

/**
 * A grammar title without a repeat of its pattern: '〜は〜です — "X is Y"' →
 * '"X is Y"', and '〜まえに・〜あとで — "before", "after"' → '"before", "after"'
 * (the pattern is shown above it). A name in English words ('い-adjectives',
 * 'Dictionary form') says something the pattern doesn't, so it stays, unless the
 * name is the pattern itself ('AかB・〜にします').
 */
export function grammarGloss(point: Pick<GrammarPoint, 'title' | 'pattern'>): string {
  const [name, gloss] = point.title.split(' — ');
  return gloss && (name.trim() === rubyToPlain(point.pattern).trim() || !/[A-Za-z]/.test(name)) ? gloss : point.title;
}
