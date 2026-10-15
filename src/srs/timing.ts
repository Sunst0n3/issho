// Seconds per card: what one answer of each card family costs this learner.
// The governor prices reviews with these: the learner's own median once there are
// enough logs, else a planning default.

import Dexie from 'dexie';
import { db } from '../lib/db.ts';
import type { CardType, ItemKind, ReviewLogRecord } from '../lib/types.ts';

export type TimingKey =
  | 'kanaRead' | 'kanaWrite' | 'kanjiWrite' | 'kanjiMeaning' | 'wordRead'
  | 'produce' | 'listen' | 'comprehend' | 'build' | 'cloze';

export const TIMING_KEYS: readonly TimingKey[] = [
  'kanaRead', 'kanaWrite', 'kanjiWrite', 'kanjiMeaning', 'wordRead',
  'produce', 'listen', 'comprehend', 'build', 'cloze',
];

export const DEFAULT_SECONDS: Record<TimingKey, number> = {
  kanaRead: 6, kanaWrite: 12, kanjiWrite: 22, kanjiMeaning: 8, wordRead: 11,
  produce: 12, listen: 7, comprehend: 10, build: 18, cloze: 15,
};
/** Last N logs of the key. */
export const MEDIAN_WINDOW = 200;
/** Below this many logs, the default. */
export const MEDIAN_MIN_LOGS = 30;
export const SECONDS_MIN = 3;
export const SECONDS_MAX = 60;

/**
 * pure: kana|read, kanaRule|read → kanaRead; kana|write → kanaWrite; kanji|write → kanjiWrite;
 * kanji|meaning → kanjiMeaning; word|read, core|read → wordRead; *|produce → produce; core|listen → listen;
 * grammar|comprehend → comprehend; grammar|build → build; sentence|cloze → cloze.
 */
export function timingKeyOf(kind: ItemKind, type: CardType): TimingKey {
  switch (type) {
    case 'read':
      return kind === 'kana' || kind === 'kanaRule' ? 'kanaRead' : 'wordRead';
    case 'write':
      return kind === 'kana' ? 'kanaWrite' : 'kanjiWrite';
    case 'meaning':
      return 'kanjiMeaning';
    case 'produce':
      return 'produce';
    case 'listen':
      return 'listen';
    case 'comprehend':
      return 'comprehend';
    case 'build':
      return 'build';
    case 'cloze':
      return 'cloze';
  }
}

/** The card types whose logs can belong to a key. */
const TYPES_OF_KEY: Record<TimingKey, CardType> = {
  kanaRead: 'read', kanaWrite: 'write', kanjiWrite: 'write', kanjiMeaning: 'meaning', wordRead: 'read',
  produce: 'produce', listen: 'listen', comprehend: 'comprehend', build: 'build', cloze: 'cloze',
};

/** pure: median of the durations in seconds, clamped to 3–60, or null with fewer than 30. */
export function medianSeconds(durationsMs: readonly number[]): number | null {
  const values = durationsMs.filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (values.length < MEDIAN_MIN_LOGS) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.min(SECONDS_MAX, Math.max(SECONDS_MIN, median / 1000));
}

/** A log whose duration measures an answer: a partner's verdict is logged with 0 ms (nobody timed it). */
function timed(log: Pick<ReviewLogRecord, 'mode'>): boolean {
  return log.mode !== 'partner';
}

/** Per-user seconds per key: the median of the last 200 timed logs of that key when ≥ 30, else DEFAULT_SECONDS. */
export async function secondsPerKey(now: Date = new Date()): Promise<Record<TimingKey, number>> {
  const out = { ...DEFAULT_SECONDS };
  const types = [...new Set(Object.values(TYPES_OF_KEY))];
  // One range read per card type (oldest first), split by key in memory: far cheaper than a filtered cursor.
  const byType = await Promise.all(
    types.map((type) => db.reviewLogs.where('[type+reviewedAt]').between([type, Dexie.minKey], [type, now], true, true).toArray()),
  );
  const durations = new Map<TimingKey, number[]>();
  for (const logs of byType) {
    for (const log of logs) {
      if (!timed(log)) continue;
      const key = timingKeyOf(log.kind, log.type);
      let list = durations.get(key);
      if (!list) durations.set(key, (list = []));
      list.push(log.durationMs);
    }
  }
  for (const key of TIMING_KEYS) {
    out[key] = medianSeconds((durations.get(key) ?? []).slice(-MEDIAN_WINDOW)) ?? DEFAULT_SECONDS[key];
  }
  return out;
}
