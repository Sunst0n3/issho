// The pitch-ear drill: which drop does the word have, heard with が after it?
// A Leitner box per word, never FSRS. Only words with a verified accent and a
// 'pitch:<ref>' clip (word + が) are drilled: alone, heiban and odaka sound the same.

import { clipRef as clipRefs } from '../../shared/voicevox.ts';
import type { AccentFile, AccentInfo, AudioManifest, PitchBoxRecord } from '../lib/types.ts';
import type { WordInfo } from '../lib/data.ts';
import { dayKey, db } from '../lib/db.ts';
import { addDays } from './days.ts';
import { shuffle } from './random.ts';

export const PITCH_BOX_DAYS = [0, 1, 3, 7, 14] as const;
export const PITCH_DRILL_MIN = 8;
export const PITCH_DRILL_MAX = 12;

/** clipRef is always 'pitch:<ref>' (the word followed by が); the diagram has moras.length + 1 positions. */
export interface PitchItem { ref: string; written: string; kana: string; accent: AccentInfo; clipRef: string }

/**
 * pure: known words with an accent entry measured with が (`accent.withGa`) and a 'pitch:<ref>' clip in the manifest.
 * Words without that clip (verbs, adjectives, words outside the clip scope) are never drilled: in isolation heiban and
 * odaka sound the same, so the drill could not be answered by ear. They still get a PitchLine.
 */
export function pitchCandidates(
  accent: AccentFile,
  manifest: AudioManifest,
  isKnown: (ref: string) => boolean,
  info: (ref: string) => WordInfo | undefined,
): PitchItem[] {
  const out: PitchItem[] = [];
  for (const [ref, entry] of Object.entries(accent)) {
    if (!entry.withGa) continue;
    const clipRef = clipRefs.pitch(ref);
    if (!manifest.byRef[clipRef] || !isKnown(ref)) continue;
    const word = info(ref);
    if (!word) continue;
    out.push({ ref, written: word.written, kana: word.kana, accent: entry, clipRef });
  }
  return out;
}

/** A long vowel: ー, an o-row kana + う (おう, こう…) or an e-row kana + い (えい, せい…). */
const LONG_VOWEL = /ー|[おこごそぞとどのほぼぽもよょろオコゴソゾトドノホボポモヨョロ][うウ]|[えけげせぜてでねへべぺめれエケゲセゼテデネヘベペメレ][いイ]/u;

/** Drill weight: heiban ×2; a long vowel (ー, おう, えい) ×1.5; ん or っ ×1.5. */
export function pitchWeight(item: PitchItem): number {
  let w = item.accent.type === 'heiban' || item.accent.drop === 0 ? 2 : 1;
  if (LONG_VOWEL.test(item.kana) || item.accent.moras.includes('ー')) w *= 1.5;
  if (/[んっンッ]/.test(item.kana)) w *= 1.5;
  return w;
}

function isDue(item: PitchItem, boxes: ReadonlyMap<string, PitchBoxRecord>, today: string): boolean {
  const box = boxes.get(item.ref);
  return !box || box.nextDay <= today;
}

/**
 * pure: 8–12 items due by box, drawn by weight (heiban ×2; a long vowel ×1.5; ん or っ ×1.5). Minimal-pair groups
 * (same kana, different drop, e.g. はし 箸/橋/端) go in together when ≥ 2 members are known. Too few due items are
 * topped up with the ones due soonest, so a drill always has something to play.
 */
export function pickPitchDrill(
  cands: readonly PitchItem[],
  boxes: ReadonlyMap<string, PitchBoxRecord>,
  today: string,
  random: () => number,
  n = 10,
): PitchItem[] {
  const size = Math.min(PITCH_DRILL_MAX, Math.max(PITCH_DRILL_MIN, n));
  const groups = new Map<string, PitchItem[]>();
  for (const c of cands) groups.set(c.kana, [...(groups.get(c.kana) ?? []), c]);
  const pairsOf = (item: PitchItem) => {
    const group = groups.get(item.kana) ?? [];
    const drops = new Set(group.map((g) => g.accent.drop));
    return group.length >= 2 && drops.size >= 2 ? group : [item];
  };

  const picked: PitchItem[] = [];
  const taken = new Set<string>();
  const add = (item: PitchItem) => {
    for (const member of pairsOf(item)) {
      if (taken.has(member.ref) || picked.length >= PITCH_DRILL_MAX) continue;
      taken.add(member.ref);
      picked.push(member);
    }
  };

  // Weighted sampling without replacement among the due items.
  const due = cands.filter((c) => isDue(c, boxes, today));
  const pool = shuffle(due, random);
  while (picked.length < size && pool.length) {
    const total = pool.reduce((s, c) => s + pitchWeight(c), 0);
    let at = random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      at -= pitchWeight(pool[i]);
      if (at < 0) {
        index = i;
        break;
      }
    }
    const [item] = pool.splice(index, 1);
    if (!taken.has(item.ref)) add(item);
  }
  if (picked.length < PITCH_DRILL_MIN) {
    const soonest = cands
      .filter((c) => !taken.has(c.ref))
      .sort((a, b) => (boxes.get(a.ref)?.nextDay ?? '').localeCompare(boxes.get(b.ref)?.nextDay ?? ''));
    for (const item of soonest) {
      if (picked.length >= PITCH_DRILL_MIN) break;
      add(item);
    }
  }
  return picked;
}

/** Right → box + 1 (max 4), wrong → box 0; nextDay = today + PITCH_BOX_DAYS[box]. Never FSRS. */
export async function recordPitch(ref: string, correct: boolean, now: Date = new Date()): Promise<void> {
  const today = dayKey(now);
  await db.transaction('rw', db.pitchBoxes, async () => {
    const row = await db.pitchBoxes.get(ref);
    const box = (correct ? Math.min(4, (row?.box ?? 0) + 1) : 0) as PitchBoxRecord['box'];
    await db.pitchBoxes.put({
      ref,
      box,
      nextDay: addDays(today, PITCH_BOX_DAYS[box]),
      seen: (row?.seen ?? 0) + 1,
      correct: (row?.correct ?? 0) + (correct ? 1 : 0),
    });
  });
}

/** pure: the options for a word of n moras heard with が: drop 0 (heiban: が stays high), 1..n (n = odaka: が is low). */
export function pitchOptions(moraCount: number): number[] {
  return Array.from({ length: Math.max(0, moraCount) + 1 }, (_, i) => i);
}
