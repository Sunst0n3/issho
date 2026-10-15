// Milestones and progress framing: text coverage by kanji, chapters of 15 kanji,
// seasons of 12 weeks, hour benchmarks, the plan's milestones and which
// celebrations were already shown.

import { dayKey, db } from '../lib/db.ts';
import { loadCurriculum } from '../lib/data.ts';
import type { MilestoneRecord, WordRef } from '../lib/types.ts';
import { addDays, daysBetween } from './days.ts';
import { firstStudyDay } from './habits.ts';

export const COVERAGE_TABLE: readonly (readonly [kanji: number, share: number])[] =
  [[100, 0.74], [200, 0.79], [300, 0.83], [500, 0.88], [700, 0.92], [1000, 0.95]];

/** pure: linear interpolation of the table; null below 100 kanji (the UI shows "100 kanji ≈ 74 %" as the next goal); 0.95 from 1,000. */
export function coverageShare(kanjiLearned: number): number | null {
  const [first] = COVERAGE_TABLE;
  if (kanjiLearned < first[0]) return null;
  const last = COVERAGE_TABLE[COVERAGE_TABLE.length - 1];
  if (kanjiLearned >= last[0]) return last[1];
  for (let i = 1; i < COVERAGE_TABLE.length; i++) {
    const [k1, s1] = COVERAGE_TABLE[i];
    if (kanjiLearned > k1) continue;
    const [k0, s0] = COVERAGE_TABLE[i - 1];
    return Math.round((s0 + ((kanjiLearned - k0) / (k1 - k0)) * (s1 - s0)) * 1000) / 1000;
  }
  return last[1];
}

export const CHAPTER_SIZE = 15;
export interface ChapterInfo { chapter: number; done: number; size: number; half: 'done' | 'left'; text: string }

/**
 * pure. Kana phase (no kanji yet): chapter 0, size 92, 'Chapter 0 · Kana · 46 of 92'. Then chapter = floor(k / 15) + 1,
 * done = k % 15; done ≤ 7 → 'Chapter 7 · 5 of 15 done'; done ≥ 8 → 'Chapter 7 · 6 to go'.
 */
export function chapterInfo(kanjiIntroduced: number, kanaIntroduced: number, kanaTotal: number): ChapterInfo {
  if (kanjiIntroduced <= 0) {
    const done = Math.min(kanaIntroduced, kanaTotal);
    return {
      chapter: 0,
      done,
      size: kanaTotal,
      half: done <= kanaTotal / 2 ? 'done' : 'left',
      text: `Chapter 0 · Kana · ${done} of ${kanaTotal}`,
    };
  }
  const chapter = Math.floor(kanjiIntroduced / CHAPTER_SIZE) + 1;
  const done = kanjiIntroduced % CHAPTER_SIZE;
  const half = done <= 7 ? 'done' : 'left';
  const text = half === 'done' ? `Chapter ${chapter} · ${done} of ${CHAPTER_SIZE} done` : `Chapter ${chapter} · ${CHAPTER_SIZE - done} to go`;
  return { chapter, done, size: CHAPTER_SIZE, half, text };
}

/**
 * What a chapter taught: its span runs from the day its first kanji was introduced (chapter 0: the first study day) to
 * the day before the next chapter's first kanji (open-ended for the current chapter). Lists the kanji of the chapter
 * and every word (core/word) and grammar item whose introducedAt falls in the span.
 */
export async function chapterItems(
  chapter: number,
  now: Date = new Date(),
): Promise<{ from: string; to: string | null; kanji: string[]; words: WordRef[]; grammar: string[] }> {
  const [curriculum, items, firstDay] = await Promise.all([loadCurriculum(), db.items.toArray(), firstStudyDay(now)]);
  const introduced = new Map(items.map((i) => [i.id, dayKey(i.introducedAt)]));
  const firstKanjiDay = (n: number): string | undefined => {
    let first: string | undefined;
    for (const u of curriculum.units) {
      if (u.chapter !== n) continue;
      const day = introduced.get(`kanji:${u.char}`);
      if (day && (!first || day < first)) first = day;
    }
    return first;
  };

  const from = chapter === 0 ? firstDay : firstKanjiDay(chapter);
  if (from === undefined) return { from: '', to: null, kanji: [], words: [], grammar: [] };
  const nextStart = firstKanjiDay(chapter + 1);
  const to = nextStart ? addDays(nextStart, -1) : null;
  const inSpan = (day: string) => day >= from && (to === null || day <= to);

  const kanji = chapter === 0
    ? []
    : [...curriculum.units]
      .sort((a, b) => a.index - b.index)
      .filter((u) => u.chapter === chapter && introduced.has(`kanji:${u.char}`))
      .map((u) => u.char);
  const sorted = [...items].sort((a, b) => a.introducedAt.getTime() - b.introducedAt.getTime());
  const words = sorted
    .filter((i) => (i.kind === 'word' || i.kind === 'core') && inSpan(dayKey(i.introducedAt)))
    .map((i) => i.id as WordRef);
  const grammar = sorted.filter((i) => i.kind === 'grammar' && inSpan(dayKey(i.introducedAt))).map((i) => i.key);
  return { from, to, kanji, words, grammar };
}

export const SEASON_WEEKS = 12;

/** pure: the season number whose finale is due (12·n weeks after the first study day, not yet seen), else null. */
export function seasonFinaleDue(firstDay: string, today: string, seen: ReadonlySet<string>): number | null {
  const season = Math.floor(daysBetween(firstDay, today) / (SEASON_WEEKS * 7));
  if (season < 1) return null;
  return seen.has(`season:${season}`) || seen.has(String(season)) ? null : season;
}

export const HOUR_BENCHMARKS: readonly { id: 'n5' | 'n4' | 'fsi'; label: string; from: number; to: number }[] = [
  { id: 'n5', label: 'old JLPT N5', from: 250, to: 400 },
  { id: 'n4', label: 'old JLPT N4', from: 500, to: 750 },
  { id: 'fsi', label: 'FSI professional (long view)', from: 2200, to: 2200 },
];

export const PLAN_MILESTONES: readonly { id: 'M0' | 'M1' | 'M2' | 'M3' | 'M4'; day: number; kanji: [number, number]; words: number; grammar: [number, number] }[] = [
  { id: 'M0', day: 14, kanji: [0, 0], words: 35, grammar: [2, 2] },
  { id: 'M1', day: 90, kanji: [100, 100], words: 500, grammar: [35, 35] },
  { id: 'M2', day: 180, kanji: [175, 175], words: 900, grammar: [60, 60] },
  { id: 'M3', day: 365, kanji: [265, 310], words: 1550, grammar: [85, 100] },
  { id: 'M4', day: 730, kanji: [390, 490], words: 2500, grammar: [115, 115] },
];

/** Records a reached milestone (idempotent: an existing row is kept). */
export async function recordMilestone(id: string, now: Date = new Date()): Promise<void> {
  await db.transaction('rw', db.milestones, async () => {
    if (!(await db.milestones.get(id))) await db.milestones.add({ id, reachedAt: now });
  });
}

/** Marks a milestone's celebration as shown (recording it first when needed). */
export async function markMilestoneSeen(id: string, now: Date = new Date()): Promise<void> {
  await db.transaction('rw', db.milestones, async () => {
    const row = await db.milestones.get(id);
    if (!row) await db.milestones.add({ id, reachedAt: now, seenAt: now });
    else if (!row.seenAt) await db.milestones.put({ ...row, seenAt: now });
  });
}

/** Milestones reached but not yet celebrated, oldest first. */
export async function unseenMilestones(_now: Date = new Date()): Promise<MilestoneRecord[]> {
  const rows = await db.milestones.toArray();
  return rows.filter((m) => !m.seenAt).sort((a, b) => a.reachedAt.getTime() - b.reachedAt.getTime());
}
