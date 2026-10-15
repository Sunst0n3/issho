// Picks the common JMdict words that can be taught with the jōyō kanji, and the readings a
// learner may type for a JMdict entry (altKana).

import { isKanji } from '../../src/lib/ruby.ts';
import type { WordEntry } from '../../src/lib/types.ts';
import { cleanGlosses } from './gloss.ts';
import type { JmEntry, JmKanji, JmReading, JmSense } from './jmdict.ts';

const PRIORITY_RE = /^(news1|ichi1|spec1|spec2|gai1|nf\d\d)$/;

/** Spellings that are irregular, outdated, rare or search-only. */
const SKIP_KANJI_INFO = new Set(['iK', 'io', 'oK', 'rK', 'sK']);
const SKIP_READING_INFO = new Set(['ik', 'ok', 'rk', 'sk']);
/** Senses not worth teaching to beginners. */
const SKIP_SENSE_MISC = new Set(['arch', 'obs', 'vulg', 'X']);
/**
 * Register-marked senses: fine to know, but not the word to meet a kanji with
 * (食う "to eat", male speech, when 食べる is there; 飯 めし next to ご飯).
 */
const MARKED_REGISTER_MISC = new Set(['male', 'fem', 'sl', 'col', 'derog']);
/** Senses never taught as the word for a kanji: derogatory, sensitive or slang. */
const OFFENSIVE_MISC = new Set(['derog', 'sens', 'sl']);

/** Rank for common words that have no nfXX tag. */
export const COMMON_WITHOUT_NF = 49;
/**
 * A kanji spelling of a word "usually written in kana" (uk) is still taught when
 * newspapers use it this often: news1 plus an nfXX bucket at or below this.
 * Single-character spellings (為 ため, 事 こと) are excluded: their counts come
 * mostly from other words and they would crowd out real words for that kanji.
 */
const UK_MAX_NF = 12;

const KANA_OR_MARK_RE = /^[ぁ-ゖァ-ヺー々]$/u;
const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

const isPriority = (tag: string) => PRIORITY_RE.test(tag);

/** nfXX bucket of a spelling or reading (1 = most frequent), if any. */
export function nfRank(pri: string[]): number | undefined {
  for (const tag of pri) if (/^nf\d\d$/.test(tag)) return Number(tag.slice(2));
  return undefined;
}

/** True when every character is a jōyō kanji, kana, ー or 々. */
export function usesOnlyJoyo(text: string, isJoyo: (ch: string) => boolean): boolean {
  for (const ch of text) {
    if (isKanji(ch) ? !isJoyo(ch) : !KANA_OR_MARK_RE.test(ch)) return false;
  }
  return true;
}

function isVeryCommonSpelling(k: JmKanji): boolean {
  const nf = nfRank(k.pri);
  return [...k.text].length > 1 && k.pri.includes('news1') && nf !== undefined && nf <= UK_MAX_NF;
}

function pickReading(e: JmEntry, written: string): JmReading | undefined {
  const fits = e.readings.filter((r) => !r.noKanji && (r.restr.length === 0 || r.restr.includes(written)));
  const regular = fits.filter((r) => !r.info.some((i) => SKIP_READING_INFO.has(i)));
  return regular.find((r) => r.pri.some(isPriority)) ?? regular[0] ?? fits[0];
}

function readingApplies(r: JmReading, written: string | undefined): boolean {
  if (written === undefined) return true;
  return !r.noKanji && (r.restr.length === 0 || r.restr.includes(written));
}

const O_COLUMN = new Set([...'おこそとのほもよろをごぞどぼぽょ']);
const E_COLUMN = new Set([...'えけせてねへめれげぜでべぺ']);

/**
 * Spellings of `kana` (in hiragana) with one long vowel written the other way: an o-column mora
 * plus う ↔ お (とおり / とうり) and an e-column mora plus い ↔ え (せんせい / せんせえ).
 */
export function longVowelVariants(kana: string): string[] {
  const chars = [...toHiragana(kana)];
  const out = new Set<string>();
  chars.forEach((ch, i) => {
    const prev = chars[i - 1];
    if (prev === undefined) return;
    let to: string | undefined;
    if (O_COLUMN.has(prev)) to = ch === 'う' ? 'お' : ch === 'お' ? 'う' : undefined;
    else if (E_COLUMN.has(prev)) to = ch === 'い' ? 'え' : ch === 'え' ? 'い' : undefined;
    if (to) out.add([...chars.slice(0, i), to, ...chars.slice(i + 1)].join(''));
  });
  return [...out];
}

/**
 * Other kana a learner may type for an entry read as `kana` (spelled `written`, or kana-only when
 * undefined): the entry's other common readings for that spelling (regular, with a JMdict priority
 * tag: 明日 あす, 四 し), plus the long-vowel variants (おう ↔ おお, えい ↔ ええ) whenever JMdict lists
 * them, even as an irregular or search-only reading. Rare readings are left out, because a typed
 * answer would accept another word (祖父 おじ is "uncle", 牛 ぎゅう "beef", 理由 わけ), and so are
 * spellings that differ only in script (うん / ウン), which typing already folds together.
 */
export function entryAltKana(e: JmEntry, written: string | undefined, kana: string): string[] {
  const out: string[] = [];
  const own = toHiragana(kana);
  const variants = new Set(longVowelVariants(kana));
  for (const r of e.readings) {
    const folded = toHiragana(r.text);
    if (folded === own || out.some((o) => toHiragana(o) === folded) || !readingApplies(r, written)) continue;
    const common = r.pri.length > 0 && !r.info.some((i) => SKIP_READING_INFO.has(i));
    if (common || variants.has(folded)) out.push(r.text);
  }
  return out;
}

/**
 * altKana of a core word from its JMdict entry: the entry's alternates for the core word's own
 * spelling and reading, minus the readings of other core words on the same entry (十 じゅう is
 * not an alternate of 十 とお). Nothing when the entry does not spell or read the core word itself
 * (びっくりする on the entry びっくり, 説明する on 説明): its readings are another word's.
 */
export function coreAltKana(
  c: { kana: string; written?: string },
  entry: JmEntry | undefined,
  siblings: ReadonlySet<string> = new Set(),
): string[] {
  if (!entry || !entry.readings.some((r) => toHiragana(r.text) === toHiragana(c.kana))) return [];
  const spelling = c.written === undefined ? undefined : entry.kanji.find((k) => k.text === c.written)?.text;
  if (c.written !== undefined && spelling === undefined) return [];
  return entryAltKana(entry, spelling, c.kana).filter((k) => !siblings.has(k));
}

/** Every priority tag of a spelling and its reading (ke_pri then re_pri), without duplicates. */
export function priorityTags(spelling: JmKanji | undefined, reading: JmReading): string[] {
  return [...new Set([...(spelling?.pri ?? []), ...reading.pri])];
}

function senseApplies(s: JmSense, written: string, kana: string): boolean {
  return (s.stagk.length === 0 || s.stagk.includes(written)) && (s.stagr.length === 0 || s.stagr.includes(kana));
}

export interface SelectedWord {
  word: WordEntry;
  /** The spelling is in JMdict's basic-vocabulary list (ichi1) and the sense is neutral in register. */
  basic: boolean;
  /** The sense is derogatory, sensitive or slang (土人 どじん): kept for reading, never taught with a kanji. */
  offensive: boolean;
}

/**
 * The WordEntry for a JMdict entry, or undefined when it should not be taught:
 * not common, no common kanji spelling, non-jōyō kanji, usually written in kana
 * (unless the kanji spelling is itself very common), or no usable sense.
 */
export function selectWord(e: JmEntry, isJoyo: (ch: string) => boolean): SelectedWord | undefined {
  const spelling = e.kanji.find((k) => k.pri.some(isPriority) && !k.info.some((i) => SKIP_KANJI_INFO.has(i)));
  if (!spelling || !usesOnlyJoyo(spelling.text, isJoyo)) return undefined;
  const kanji = [...new Set([...spelling.text].filter(isKanji))];
  if (kanji.length === 0) return undefined;

  const reading = pickReading(e, spelling.text);
  if (!reading) return undefined;

  const sense = e.senses.find((s) => senseApplies(s, spelling.text, reading.text));
  if (!sense || sense.misc.some((m) => SKIP_SENSE_MISC.has(m))) return undefined;
  if (sense.misc.includes('uk') && !isVeryCommonSpelling(spelling)) return undefined;

  const meanings = cleanGlosses(sense.glosses);
  if (meanings.length === 0) return undefined;

  const word: WordEntry = {
    id: e.id,
    written: spelling.text,
    kana: reading.text,
    meanings,
    pos: sense.pos,
    freqRank: nfRank(spelling.pri) ?? COMMON_WITHOUT_NF,
    kanji,
    pri: priorityTags(spelling, reading),
  };
  const altKana = entryAltKana(e, spelling.text, reading.text);
  if (altKana.length > 0) word.altKana = altKana;
  return {
    word,
    basic: spelling.pri.includes('ichi1') && !sense.misc.some((m) => MARKED_REGISTER_MISC.has(m)),
    offensive: sense.misc.some((m) => OFFENSIVE_MISC.has(m)),
  };
}
