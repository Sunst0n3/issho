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

/** Compact interval for self-grade buttons: "1m", "6h", "1d", "12d", "3mo", "1y". */
export function shortInterval(due: Date, now: Date = new Date()): string {
  const ms = Math.max(0, due.getTime() - now.getTime());
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = Math.round(ms / DAY);
  if (days < 45) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30.4)}mo`;
  return `${Math.round(days / 365)}y`;
}

/** A KANJIDIC reading without okurigana dots or affix dashes: 'た.べる' → 'たべる', '-び' → 'び'. */
export function cleanReading(reading: string): string {
  return reading.replace(/[.\-]/g, '');
}

const SMALL_VOWEL: Record<string, string> = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };

/** Romaji from the kana course table, for showing readings to beginners. */
export function kanaToRomaji(text: string, kana: readonly KanaEntry[]): string {
  const table = new Map<string, string>();
  for (const k of kana) table.set(toHiragana(k.char), k.romaji);
  const chars = [...toHiragana(cleanReading(text))];
  let out = '';
  let double = false;
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] ?? '');
    let romaji: string | undefined;
    if (table.has(pair)) {
      romaji = table.get(pair);
      i++;
    } else if (chars[i] === 'っ') {
      double = true;
      continue;
    } else if (chars[i] === 'ー') {
      romaji = out.at(-1) ?? '';
    } else {
      romaji = table.get(chars[i]) ?? SMALL_VOWEL[chars[i]] ?? chars[i];
    }
    if (double && romaji) {
      out += romaji.startsWith('ch') ? 't' : romaji[0];
      double = false;
    }
    out += romaji;
  }
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

/** A grammar title without a repeat of its pattern: '〜は〜です — "X is Y"' → '"X is Y"'. */
export function grammarGloss(point: Pick<GrammarPoint, 'title' | 'pattern'>): string {
  const [name, gloss] = point.title.split(' — ');
  return gloss && rubyToPlain(point.pattern).startsWith(name.slice(0, 2)) ? gloss : point.title;
}
