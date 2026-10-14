// Progress: known items, streaks, daily stats and the hardest kanji.

import { State } from 'ts-fsrs';
import { dayKey, db } from '../lib/db.ts';
import type { CardRecord, DayRecord } from '../lib/types.ts';
import { addDays, countableMs, DAY_MS, emptyDay, studyDayLookback, updateDay, weekStart } from './days.ts';

/** Every introduced kanji, oldest first. */
export async function knownKanji(): Promise<string[]> {
  const items = await db.items.where('kind').equals('kanji').toArray();
  return items.sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime()).map((i) => i.key);
}

/**
 * Ids of the items introduced today, in the order they were introduced. Words
 * that came with a kanji are included (filter by kind as needed); items the
 * learner marked as already known are not, since they weren't learned today.
 */
export async function learnedToday(now: Date = new Date()): Promise<string[]> {
  const today = dayKey(now);
  const items = await db.items
    .where('introducedAt')
    .aboveOrEqual(studyDayLookback(now))
    .filter((i) => dayKey(i.introducedAt) === today)
    .toArray();
  if (!items.length) return [];

  const ids = items.map((i) => i.id);
  const [cards, logs] = await Promise.all([
    db.cards.where('itemId').anyOf(ids).toArray(),
    db.reviewLogs.where('itemId').anyOf(ids).toArray(),
  ]);
  // markKnown moves cards straight to Review without grading them: an item with
  // neither a review nor a card still waiting for its first one was marked known.
  const graded = new Set(logs.map((l) => l.itemId));
  const unseen = new Set(cards.filter((c) => c.reps === 0).map((c) => c.itemId));
  return ids.filter((id) => graded.has(id) || unseen.has(id));
}

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------

/** 'before': a past day before the learner's first day on this phone (neither done nor missed). */
export type DayStatus = 'done' | 'rest' | 'missed' | 'today' | 'future' | 'before';

export interface StreakInfo {
  /** Completed days in the current streak (rest days keep it alive but don't add to it). */
  current: number;
  best: number;
  todayDone: boolean;
  /** Monday → Sunday of this week. */
  week: { date: string; status: DayStatus }[];
}

interface StreakWalk {
  current: number;
  best: number;
  /** Rest days the current streak relies on. */
  rests: string[];
}

/**
 * Replays every day from the first completed one up to today. The first missed
 * day in an ISO week that interrupts a streak is that week's rest day; any
 * other missed day in the week ends the streak. Today never ends it, since the
 * day isn't over. Going forward means a rest day, once taken, never moves.
 */
function walkStreak(doneDays: Iterable<string>, today: string): StreakWalk {
  const done = new Set([...doneDays].filter((d) => d <= today));
  const walk: StreakWalk = { current: 0, best: 0, rests: [] };
  const restWeeks = new Set<string>();
  const first = [...done].sort()[0];
  for (let d = first; d !== undefined && d <= today; d = addDays(d, 1)) {
    if (done.has(d)) {
      walk.current++;
      walk.best = Math.max(walk.best, walk.current);
    } else if (d !== today && walk.current > 0) {
      const week = weekStart(d);
      if (restWeeks.has(week)) {
        walk.current = 0;
        walk.rests = [];
      } else {
        restWeeks.add(week);
        walk.rests.push(d);
      }
    }
  }
  return walk;
}

/**
 * Streak figures from the keys of days with a completed session. Past days
 * before `startDay` (the learner's first day, see firstStudyDay) are 'before'
 * rather than 'missed'.
 */
export function streakFromDays(doneDays: Iterable<string>, today: string, startDay?: string): StreakInfo {
  const done = new Set([...doneDays].filter((d) => d <= today));
  const walk = walkStreak(done, today);
  const rests = new Set(walk.rests);
  const monday = weekStart(today);
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    let status: DayStatus;
    if (date > today) status = 'future';
    else if (done.has(date)) status = 'done';
    else if (date === today) status = 'today';
    else if (startDay !== undefined && date < startDay) status = 'before';
    else status = rests.has(date) ? 'rest' : 'missed';
    return { date, status };
  });

  return { current: walk.current, best: walk.best, todayDone: done.has(today), week };
}

/** Rest days the current streak relies on. */
export function restDaysOf(doneDays: Iterable<string>, today: string): string[] {
  return walkStreak(doneDays, today).rests;
}

async function completedDays(): Promise<string[]> {
  return (await db.days.filter((d) => d.sessionComplete).toArray()).map((d) => d.date);
}

/**
 * The learner's first day on this phone: the earliest day with a record or an
 * introduced item (kana marked known at onboarding count), else today.
 */
export async function firstStudyDay(now: Date = new Date()): Promise<string> {
  const today = dayKey(now);
  const [firstRecord, firstItem] = await Promise.all([
    db.days.toCollection().first(),
    db.items.orderBy('introducedAt').first(),
  ]);
  const candidates = [today];
  if (firstRecord) candidates.push(firstRecord.date);
  if (firstItem) candidates.push(dayKey(firstItem.introducedAt));
  return candidates.sort()[0];
}

export async function streak(now: Date = new Date()): Promise<StreakInfo> {
  const [done, start] = await Promise.all([completedDays(), firstStudyDay(now)]);
  return streakFromDays(done, dayKey(now), start);
}

/** Marks today's session complete (and records the rest days it relies on). */
export async function completeSession(now: Date = new Date()): Promise<StreakInfo> {
  const today = dayKey(now);
  await db.transaction('rw', db.days, async () => {
    await updateDay(today, (day) => {
      day.sessionComplete = true;
    });
    for (const rest of restDaysOf(await completedDays(), today)) {
      await updateDay(rest, (day) => {
        day.restDay = true;
      });
    }
  });
  return streak(now);
}

/** Adds study time outside graded cards (reading, writing practice, role-play). */
export async function addStudyTime(ms: number, now: Date = new Date()): Promise<void> {
  await updateDay(dayKey(now), (day) => {
    day.studyMs += countableMs(ms);
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface HardKanji {
  char: string;
  /** Lapses summed over the kanji's cards. */
  lapses: number;
  /** Lowest stability among its reviewed cards, days. */
  stability: number;
}

/** Pure ranking behind hardestKanji: most lapses, then lowest stability. */
export function rankHardKanji(cards: readonly CardRecord[], n: number): HardKanji[] {
  const byItem = new Map<string, HardKanji>();
  for (const card of cards) {
    if (card.kind !== 'kanji' || card.reps === 0 || card.suspended) continue;
    const char = card.itemId.slice('kanji:'.length);
    const entry = byItem.get(card.itemId) ?? { char, lapses: 0, stability: Infinity };
    entry.lapses += card.lapses;
    entry.stability = Math.min(entry.stability, card.stability);
    byItem.set(card.itemId, entry);
  }
  return [...byItem.values()].sort((a, b) => b.lapses - a.lapses || a.stability - b.stability).slice(0, n);
}

/** The n reviewed kanji the learner struggles with most. */
export async function hardestKanji(n: number): Promise<HardKanji[]> {
  return rankHardKanji(await db.cards.where('kind').equals('kanji').toArray(), n);
}

export interface Summary {
  kanaKnown: number;
  kanjiKnown: number;
  /** JMdict words plus survival words. */
  wordsKnown: number;
  reviewsTotal: number;
  /** Share of mature (Review-state) reviews passed in the last 30 days; null without any. */
  retention30d: number | null;
}

export async function summary(now: Date = new Date()): Promise<Summary> {
  const count = (kind: string) => db.items.where('kind').equals(kind).count();
  const [kanaKnown, kanjiKnown, words, vocab, reviewsTotal] = await Promise.all([
    count('kana'),
    count('kanji'),
    count('word'),
    count('vocab'),
    db.reviewLogs.count(),
  ]);
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const mature = (await db.reviewLogs.where('reviewedAt').aboveOrEqual(since).toArray()).filter(
    (log) => log.prevState === State.Review,
  );
  const retention30d = mature.length ? mature.filter((log) => log.grade > 1).length / mature.length : null;
  return { kanaKnown, kanjiKnown, wordsKnown: words + vocab, reviewsTotal, retention30d };
}

/** The last 7 study days, oldest first, ending today; days without a record are zeros. */
export async function weekStats(now: Date = new Date()): Promise<DayRecord[]> {
  const today = dayKey(now);
  const keys = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const records = await db.days.bulkGet(keys);
  return keys.map((k, i) => records[i] ?? emptyDay(k));
}
