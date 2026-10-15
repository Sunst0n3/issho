// Progress: what counts as learned, real retention by card family, study hours,
// reading speed, daily stats and the hardest kanji.

import { State } from 'ts-fsrs';
import { dayKey, db } from '../lib/db.ts';
import { loadWordInfo } from '../lib/data.ts';
import type { CardFamily, CardRecord, CardType, DayRecord, ItemKind, ReviewLogRecord } from '../lib/types.ts';
import { addDays, countableMs, DAY_MS, normalizeDay, studyDayLookback, updateDay } from './days.ts';

/** Every introduced kanji, oldest first. */
export async function knownKanji(): Promise<string[]> {
  const items = await db.items.where('kind').equals('kanji').toArray();
  return items.sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime()).map((i) => i.key);
}

/**
 * Ids of the items introduced today, in the order they were introduced. Words that came with a
 * kanji are included (filter by kind as needed); items the placement check marked known are not.
 */
export async function learnedToday(now: Date = new Date()): Promise<string[]> {
  const today = dayKey(now);
  const items = await db.items
    .where('introducedAt')
    .aboveOrEqual(studyDayLookback(now))
    .filter((i) => dayKey(i.introducedAt) === today && i.via !== 'placement')
    .toArray();
  return items.sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime()).map((i) => i.id);
}

// ---------------------------------------------------------------------------
// Learned
// ---------------------------------------------------------------------------

export const LEARNED_SUCCESSES = 3;

/** pure: ≥ 3 reviews with grade ≥ 2 on 3 distinct day keys strictly after introducedDay (so the first check never counts). */
export function isLearned(logs: readonly Pick<ReviewLogRecord, 'grade' | 'reviewedAt'>[], introducedDay: string): boolean {
  const days = new Set<string>();
  for (const log of logs) {
    if (log.grade < 2) continue;
    const day = dayKey(log.reviewedAt);
    if (day > introducedDay) days.add(day);
  }
  return days.size >= LEARNED_SUCCESSES;
}

export interface LearnedCounts {
  kanaLearned: number;
  /** Write card learned (a retired card that was learned still counts). */
  kanjiCanWrite: number;
  /** The anchor word (or any word with the kanji) is learned through its read card. */
  kanjiCanRead: number;
  /** word|read learned, or core|listen learned (each word once). */
  wordsLearned: number;
  /** grammar|comprehend learned. */
  grammarLearned: number;
  kanjiIntroduced: number;
  wordsIntroduced: number;
  grammarIntroduced: number;
}

export async function learnedCounts(_now: Date = new Date()): Promise<LearnedCounts> {
  const [items, logs, info] = await Promise.all([db.items.toArray(), db.reviewLogs.toArray(), loadWordInfo()]);
  const byCard = new Map<string, ReviewLogRecord[]>();
  for (const log of logs) byCard.set(log.cardId, [...(byCard.get(log.cardId) ?? []), log]);
  const learned = (itemId: string, type: CardType, introducedDay: string) => isLearned(byCard.get(`${itemId}|${type}`) ?? [], introducedDay);

  const counts: LearnedCounts = {
    kanaLearned: 0,
    kanjiCanWrite: 0,
    kanjiCanRead: 0,
    wordsLearned: 0,
    grammarLearned: 0,
    kanjiIntroduced: 0,
    wordsIntroduced: 0,
    grammarIntroduced: 0,
  };
  const introducedKanji = new Set<string>();
  const readable = new Set<string>();
  for (const item of items) {
    const day = dayKey(item.introducedAt);
    switch (item.kind) {
      case 'kana':
        if (item.via === 'placement' || learned(item.id, 'read', day)) counts.kanaLearned++;
        break;
      case 'kanji':
        counts.kanjiIntroduced++;
        introducedKanji.add(item.key);
        if (learned(item.id, 'write', day)) counts.kanjiCanWrite++;
        break;
      case 'word':
      case 'core': {
        counts.wordsIntroduced++;
        const readLearned = learned(item.id, 'read', day);
        if (readLearned) for (const k of info(item.id)?.kanji ?? []) readable.add(k);
        if (item.kind === 'word' ? readLearned : learned(item.id, 'listen', day)) counts.wordsLearned++;
        break;
      }
      case 'grammar':
        counts.grammarIntroduced++;
        if (learned(item.id, 'comprehend', day)) counts.grammarLearned++;
        break;
    }
  }
  counts.kanjiCanRead = [...readable].filter((k) => introducedKanji.has(k)).length;
  return counts;
}

// ---------------------------------------------------------------------------
// Retention by card family
// ---------------------------------------------------------------------------

export interface RetentionStat {
  family: CardFamily;
  week: { n: number; rate: number | null };
  month: { n: number; rate: number | null };
}

export const RETENTION_FAMILIES: readonly CardFamily[] = ['write', 'read', 'listen', 'produce', 'grammar'];
export const RETENTION_MIN_N = 10;
const WEEK_BUCKET = [5, 10] as const;
const MONTH_BUCKET = [21, 45] as const;

/** The retention family of a card. */
export function familyOf(kind: ItemKind, type: CardType): CardFamily {
  switch (type) {
    case 'write':
      return 'write';
    case 'read':
    case 'meaning':
      return 'read';
    case 'listen':
      return 'listen';
    case 'produce':
    case 'cloze':
      return 'produce';
    case 'comprehend':
    case 'build':
      return kind === 'grammar' ? 'grammar' : 'read';
  }
}

/**
 * pure: logs of the last 30 days with prevState Review and context 'review' or 'partner'; week bucket = elapsedDays 5–10,
 * month bucket = 21–45; rate = share with grade ≥ 2, null when n < 10. Families: write (kana/kanji write), read
 * (kana read, kanaRule, word/core read, kanji meaning), listen, produce (produce, cloze), grammar (comprehend, build).
 */
export function retentionFrom(logs: readonly ReviewLogRecord[], now: Date): RetentionStat[] {
  const since = now.getTime() - 30 * DAY_MS;
  const buckets = new Map(RETENTION_FAMILIES.map((f) => [f, { week: { n: 0, pass: 0 }, month: { n: 0, pass: 0 } }]));
  for (const log of logs) {
    const t = log.reviewedAt.getTime();
    if (t < since || t > now.getTime() || log.prevState !== State.Review) continue;
    if (log.context !== 'review' && log.context !== 'partner') continue;
    const b = buckets.get(familyOf(log.kind, log.type))!;
    const e = log.elapsedDays;
    const target = e >= WEEK_BUCKET[0] && e <= WEEK_BUCKET[1] ? b.week : e >= MONTH_BUCKET[0] && e <= MONTH_BUCKET[1] ? b.month : null;
    if (!target) continue;
    target.n++;
    if (log.grade >= 2) target.pass++;
  }
  const rate = (x: { n: number; pass: number }) => ({ n: x.n, rate: x.n < RETENTION_MIN_N ? null : x.pass / x.n });
  return RETENTION_FAMILIES.map((family) => {
    const b = buckets.get(family)!;
    return { family, week: rate(b.week), month: rate(b.month) };
  });
}

export async function retention(now: Date = new Date()): Promise<RetentionStat[]> {
  const logs = await db.reviewLogs.where('reviewedAt').between(new Date(now.getTime() - 30 * DAY_MS), now, true, true).toArray();
  return retentionFrom(logs, now);
}

// ---------------------------------------------------------------------------
// Hours and reading speed
// ---------------------------------------------------------------------------

/** Σ (studyMs + togetherMs) over all days, in hours. */
export async function hoursTotal(): Promise<number> {
  let ms = 0;
  await db.days.each((d) => {
    ms += (d.studyMs ?? 0) + (d.togetherMs ?? 0);
  });
  return ms / 3_600_000;
}

/** pure: round(chars / minutes); 0 when ms ≤ 0. */
export function charsPerMinute(chars: number, ms: number): number {
  if (!(ms > 0) || !Number.isFinite(chars)) return 0;
  return Math.round(chars / (ms / 60_000));
}

/** Characters per minute of timed re-reads: the latest and the best. */
export async function readingSpeed(): Promise<{ latest: number | null; best: number | null }> {
  const rows = await db.fluency.where('kind').equals('reread').sortBy('at');
  const values = rows.map((r) => r.value).filter((v) => Number.isFinite(v) && v > 0);
  if (!values.length) return { latest: null, best: null };
  return { latest: values.at(-1)!, best: Math.max(...values) };
}

// ---------------------------------------------------------------------------
// Study time and daily stats
// ---------------------------------------------------------------------------

/**
 * Adds study time outside graded cards: 'lesson' (teach, memory pass, free practice), 'strand' (read, output and
 * fluency, also counted against the day's strand reserve) and 'makeup' (a make-up session's reading and speed round).
 */
export async function addStudyTime(ms: number, kind: 'lesson' | 'strand' | 'makeup', now: Date = new Date()): Promise<void> {
  const counted = countableMs(ms);
  if (!counted) return;
  await updateDay(dayKey(now), (day) => {
    day.studyMs += counted;
    if (kind === 'strand') day.strandMs += counted;
    if (kind === 'makeup') day.makeupMs = (day.makeupMs ?? 0) + counted;
  });
}

export const WEEK_STATS_DAYS = 14;

/** The last 14 days, oldest first, ending today; days without a record are zeros. */
export async function weekStats(now: Date = new Date()): Promise<DayRecord[]> {
  const today = dayKey(now);
  const keys = Array.from({ length: WEEK_STATS_DAYS }, (_, i) => addDays(today, i - (WEEK_STATS_DAYS - 1)));
  const records = await db.days.bulkGet(keys);
  return keys.map((k, i) => normalizeDay(records[i], k));
}

// ---------------------------------------------------------------------------
// Hardest kanji
// ---------------------------------------------------------------------------

export interface HardKanji {
  char: string;
  /** Lapses of the kanji's write card. */
  lapses: number;
  /** Stability of the write card, days. */
  stability: number;
}

/** Pure ranking behind hardestKanji: write cards only; most lapses, then lowest stability. */
export function rankHardKanji(cards: readonly CardRecord[], n: number): HardKanji[] {
  return cards
    .filter((c) => c.kind === 'kanji' && c.type === 'write' && c.reps > 0 && !c.suspended)
    .map((c) => ({ char: c.itemId.slice('kanji:'.length), lapses: c.lapses, stability: c.stability }))
    .sort((a, b) => b.lapses - a.lapses || a.stability - b.stability)
    .slice(0, n);
}

/** The n reviewed kanji the learner struggles with most to write. */
export async function hardestKanji(n: number): Promise<HardKanji[]> {
  return rankHardKanji(await db.cards.where('kind').equals('kanji').toArray(), n);
}
