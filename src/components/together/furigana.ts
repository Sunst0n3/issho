// Readings for free text (chat messages), which has no ruby markup: the text is
// split by longest match against the written forms in words.json, and each
// matched word's kana is lined up with its kanji ("食べる" + "たべる" → 食[た]べる).
// Verbs and i-adjectives are also indexed by their inflecting stems, so 食べました
// and 書いて still match. A lone kanji with several possible readings (日: ひ, にち…),
// or a word with two equally likely ones (市場: いちば, しじょう), is left bare
// rather than guessed.

import { useEffect, useState } from 'react';
import { loadWords } from '../../lib/data.ts';
import { isKanji } from '../../lib/ruby.ts';
import type { WordEntry } from '../../lib/types.ts';
import { toHiragana } from '../../srs/answers.ts';

export interface FuriganaSegment {
  text: string;
  /** Kana reading, present only on runs of kanji. */
  reading?: string;
}

interface Entry {
  kana: string;
  rank: number;
  segments?: FuriganaSegment[];
}

export interface FuriganaDict {
  entries: Map<string, Entry>;
  /** First characters of every indexed form, to skip positions no word can start at. */
  starts: Set<string>;
  maxLen: number;
  cache: Map<string, FuriganaSegment[]>;
}

/** Longest written form tried, in characters. */
const MAX_WORD_LEN = 10;
const CACHE_SIZE = 500;

const isKanjiChar = (ch: string) => ch === '々' || isKanji(ch);

// Godan verb endings → the kana each inflected stem can end in
// (-a/-i/-e/-o rows, plus the euphonic stem used before て/た).
const GODAN_FORMS: Record<string, string[]> = {
  う: ['わ', 'い', 'え', 'お', 'っ'],
  く: ['か', 'き', 'け', 'こ', 'い'],
  ぐ: ['が', 'ぎ', 'げ', 'ご', 'い'],
  す: ['さ', 'し', 'せ', 'そ'],
  つ: ['た', 'ち', 'て', 'と', 'っ'],
  ぬ: ['な', 'に', 'ね', 'の', 'ん'],
  ぶ: ['ば', 'び', 'べ', 'ぼ', 'ん'],
  む: ['ま', 'み', 'め', 'も', 'ん'],
  る: ['ら', 'り', 'れ', 'ろ', 'っ'],
};

// 来る changes its vowel with what follows: 来た/来て/来ます/来ちゃう (き), 来ない/来よう/来い/来られる/来させる (こ).
const KURU_FORMS: Array<[string, string]> = [
  ['た', 'き'], ['て', 'き'], ['ま', 'き'], ['ち', 'き'],
  ['な', 'こ'], ['よ', 'こ'], ['い', 'こ'], ['ら', 'こ'], ['さ', 'こ'],
];

/** Extra (written, kana) forms an inflecting word can appear as in running text. */
function inflectedForms(w: WordEntry): Array<[string, string]> {
  const pos = w.pos ?? [];
  const last = w.written.slice(-1);
  const kanaLast = w.kana.slice(-1);
  if (last !== kanaLast) return [];
  const stem = w.written.slice(0, -1);
  const kanaStem = w.kana.slice(0, -1);
  if (![...stem].some(isKanjiChar)) return [];
  if (pos.includes('vk') && stem.endsWith('来') && kanaStem.endsWith('く')) {
    const kanaBase = kanaStem.slice(0, -1);
    const forms = KURU_FORMS.map(([next, vowel]): [string, string] => [stem + next, kanaBase + vowel + next]);
    // A lone 来 is also the prefix らい ("next"); a second reading leaves it bare rather than guessed.
    return stem === '来' ? [...forms, [stem, kanaStem]] : forms;
  }
  if (pos.some((p) => p === 'v1' || p.startsWith('v1-')) && last === 'る') return [[stem, kanaStem]];
  if (pos.some((p) => p.startsWith('v5'))) {
    // 行く is the one godan verb whose euphonic stem is 行っ, not 行い.
    const endings = pos.includes('v5k-s') ? ['か', 'き', 'け', 'こ', 'っ'] : GODAN_FORMS[last] ?? [];
    return endings.map((e) => [stem + e, kanaStem + e]);
  }
  if (pos.includes('adj-i') && last === 'い') {
    return [[stem, kanaStem], ...['く', 'か', 'け', 'さ'].map((e): [string, string] => [stem + e, kanaStem + e])];
  }
  return [];
}

export function buildFuriganaDict(words: readonly WordEntry[]): FuriganaDict {
  // written form → reading → best (lowest) frequency rank
  const readings = new Map<string, Map<string, number>>();
  const add = (written: string, kana: string, rank: number) => {
    if ([...written].length > MAX_WORD_LEN || ![...written].some(isKanjiChar)) return;
    const byKana = readings.get(written) ?? new Map<string, number>();
    const reading = toHiragana(kana);
    byKana.set(reading, Math.min(byKana.get(reading) ?? Infinity, rank));
    readings.set(written, byKana);
  };
  for (const w of words) {
    if (!w.written || !w.kana) continue;
    add(w.written, w.kana, w.freqRank);
    // Stems rank just behind the dictionary form, so a real word with the same spelling wins.
    // The exception is 行く: it has no newspaper rank while 行う ranks near the top, yet in
    // chat 行った/行って are almost always いった/いって.
    const stemRank = w.pos?.includes('v5k-s') ? 0 : w.freqRank + 0.5;
    for (const [written, kana] of inflectedForms(w)) add(written, kana, stemRank);
  }

  const entries = new Map<string, Entry>();
  const starts = new Set<string>();
  let maxLen = 1;
  for (const [written, byKana] of readings) {
    const chars = [...written];
    if (chars.length === 1 && byKana.size > 1) continue;
    let best: Entry | undefined;
    let tied = false;
    for (const [kana, rank] of byKana) {
      if (!best || rank < best.rank) {
        best = { kana, rank };
        tied = false;
      } else if (rank === best.rank) {
        tied = true;
      }
    }
    if (!best) continue;
    // Two readings with equal standing (開いて: あいて or ひらいて) would be a coin toss. The
    // span still matches, bare, so a shorter word inside it can't lend it a wrong reading.
    entries.set(written, tied ? { ...best, segments: [{ text: written }] } : best);
    starts.add(chars[0]);
    maxLen = Math.max(maxLen, chars.length);
  }
  return { entries, starts, maxLen, cache: new Map() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits a word's reading over its kanji runs: ("食べる", "たべる") →
 * [食|た] べる; ("取り消す", "とりけす") → [取|と] り [消|け] す. When the kana
 * parts of the spelling can't be found in the reading, the whole word gets it.
 */
export function alignReading(written: string, kana: string): FuriganaSegment[] {
  const runs: Array<{ text: string; kanji: boolean }> = [];
  for (const ch of written) {
    const kanji = isKanjiChar(ch);
    const prev = runs[runs.length - 1];
    if (prev && prev.kanji === kanji) prev.text += ch;
    else runs.push({ text: ch, kanji });
  }
  const reading = toHiragana(kana);
  if (runs.every((r) => r.kanji)) return [{ text: written, reading }];
  const pattern = runs.map((r) => (r.kanji ? '(.+?)' : escapeRegExp(toHiragana(r.text)))).join('');
  const m = new RegExp(`^${pattern}$`, 'u').exec(reading);
  if (!m) return [{ text: written, reading }];
  let group = 1;
  return runs.map((r) => (r.kanji ? { text: r.text, reading: m[group++] } : { text: r.text }));
}

/** Free text → segments, kanji runs carrying their readings where a word matched. */
export function segmentFurigana(text: string, dict: FuriganaDict): FuriganaSegment[] {
  const hit = dict.cache.get(text);
  if (hit) return hit;

  const chars = [...text];
  const out: FuriganaSegment[] = [];
  let plain = '';
  for (let i = 0; i < chars.length;) {
    let entry: Entry | undefined;
    let len = 0;
    if (dict.starts.has(chars[i])) {
      for (len = Math.min(dict.maxLen, chars.length - i); len > 0; len--) {
        entry = dict.entries.get(chars.slice(i, i + len).join(''));
        if (entry) break;
      }
    }
    if (!entry) {
      plain += chars[i];
      i++;
      continue;
    }
    if (plain) {
      out.push({ text: plain });
      plain = '';
    }
    const written = chars.slice(i, i + len).join('');
    entry.segments ??= alignReading(written, entry.kana);
    out.push(...entry.segments);
    i += len;
  }
  if (plain) out.push({ text: plain });

  // Merge neighbouring plain runs so rendering stays simple.
  const merged: FuriganaSegment[] = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.reading === undefined && seg.reading === undefined) prev.text += seg.text;
    else merged.push({ ...seg });
  }

  if (dict.cache.size >= CACHE_SIZE) dict.cache.delete(dict.cache.keys().next().value!);
  dict.cache.set(text, merged);
  return merged;
}

let shared: Promise<FuriganaDict> | null = null;

/** The dictionary built from words.json, once per page. */
export function loadFuriganaDict(): Promise<FuriganaDict> {
  if (!shared) {
    const building = loadWords().then(buildFuriganaDict);
    shared = building;
    building.catch(() => { if (shared === building) shared = null; });
  }
  return shared;
}

/** The furigana dictionary once loaded (only starts loading when `enabled`). */
export function useFuriganaDict(enabled: boolean): FuriganaDict | undefined {
  const [dict, setDict] = useState<FuriganaDict>();
  useEffect(() => {
    if (!enabled || dict) return;
    let live = true;
    loadFuriganaDict().then((d) => { if (live) setDict(d); }, () => { /* readings just stay hidden */ });
    return () => { live = false; };
  }, [enabled, dict]);
  return dict;
}
