// Picks the common JMdict words that can be taught with the jōyō kanji.

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

function senseApplies(s: JmSense, written: string, kana: string): boolean {
  return (s.stagk.length === 0 || s.stagk.includes(written)) && (s.stagr.length === 0 || s.stagr.includes(kana));
}

export interface SelectedWord {
  word: WordEntry;
  /** The spelling is in JMdict's basic-vocabulary list (ichi1) and the sense is neutral in register. */
  core: boolean;
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

  return {
    word: {
      id: e.id,
      written: spelling.text,
      kana: reading.text,
      meanings,
      pos: sense.pos,
      freqRank: nfRank(spelling.pri) ?? COMMON_WITHOUT_NF,
      kanji,
    },
    core: spelling.pri.includes('ichi1') && !sense.misc.some((m) => MARKED_REGISTER_MISC.has(m)),
  };
}
