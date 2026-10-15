// The progress summary a phone uploads with its stats (MemberProgress): effort and
// milestones, never error counts. Its own module: it needs progress, milestones,
// course and readListen, and none of them imports it, so there is no import cycle.

import type { MemberProgress } from '../../shared/api.ts';
import { dayKey, db } from '../lib/db.ts';
import { loadCoreWords, loadGrammar, loadKana, loadUnits } from '../lib/data.ts';
import type { GrammarPoint, ItemRecord } from '../lib/types.ts';
import { unitOfNextGrammar } from './course.ts';
import { daysBetween } from './days.ts';
import { streak } from './habits.ts';
import { chapterInfo } from './milestones.ts';
import { hoursTotal, learnedCounts } from './progress.ts';
import { readyStoryIds } from './readListen.ts';

/** Items introduced this many days ago feed partner games and task targets. */
export const RECENT_AGE = [2, 21] as const;
export const RECENT_MAX = 20;
/** A unit is settled when all its grammar was introduced at least this many days ago. */
export const SETTLED_AFTER_DAYS = 2;

/** pure: the highest unit n whose grammar (and that of every unit before it) was all introduced ≥ 2 days ago (0 = none). */
export function settledUnitFrom(grammar: readonly GrammarPoint[], introduced: ReadonlyMap<string, string>, today: string): number {
  const units = [...new Set(grammar.map((g) => g.unit))].sort((a, b) => a - b);
  let settled = 0;
  for (const unit of units) {
    const points = grammar.filter((g) => g.unit === unit);
    const ok = points.every((g) => {
      const day = introduced.get(`grammar:${g.id}`);
      return day !== undefined && daysBetween(day, today) >= SETTLED_AFTER_DAYS;
    });
    if (!ok) break;
    settled = unit;
  }
  return settled;
}

/**
 * pure: how far an in-order stream has reached: the highest order n such that every entry of order ≤ n is
 * introduced (0 = none). The partner side reads `order ≤ reached` as "introduced", so a word or point taught out of
 * order (a core word as a kanji's anchor or staged word, a grammar point picked by the lookahead) must not move it.
 */
export function reachedOrder(entries: readonly { id: string; order: number }[], introduced: (id: string) => boolean): number {
  let reached = 0;
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    if (!introduced(entry.id)) break;
    reached = entry.order;
  }
  return reached;
}

/**
 * pure: item ids introduced 2–21 days ago, max 20: the `first` ids (the units' authored task-card targets) ahead of the
 * rest, newest first within each. Five days of new items already fill 20, so without this the partner's phone (which
 * only sees these 20) would miss an authored target learned a week or two ago (QA V070).
 */
export function recentItemIds(
  items: readonly ItemRecord[],
  today: string,
  kinds: ReadonlySet<string>,
  first: ReadonlySet<string> = new Set(),
): string[] {
  return items
    .filter((i) => {
      if (!kinds.has(i.kind) || i.via === 'placement') return false;
      const age = daysBetween(dayKey(i.introducedAt), today);
      return age >= RECENT_AGE[0] && age <= RECENT_AGE[1];
    })
    .sort(
      (a, b) =>
        Number(first.has(b.id)) - Number(first.has(a.id)) ||
        b.introducedAt.getTime() - a.introducedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, RECENT_MAX)
    .map((i) => i.id);
}

/**
 * Summary for POST /api/stats (F maps it): every MemberProgress field, including recentItems, settledUnit,
 * coreReached and grammarReached.
 */
export async function memberProgress(now: Date = new Date()): Promise<MemberProgress> {
  const today = dayKey(now);
  const [items, grammar, core, kana, learned, hours, habits, readyStories, units] = await Promise.all([
    db.items.toArray(),
    loadGrammar(),
    loadCoreWords(),
    loadKana(),
    learnedCounts(now),
    hoursTotal(),
    streak(now),
    readyStoryIds(now),
    loadUnits(),
  ]);
  const taskTargets = new Set<string>(units.flatMap((u) => u.task?.targets ?? []));
  const introduced = new Map(items.map((i) => [i.id, dayKey(i.introducedAt)]));
  const basic = kana.filter((k) => k.kind === 'basic');
  const kanaIntroduced = basic.filter((k) => introduced.has(`kana:${k.char}`)).length;
  const coreReached = reachedOrder(core, (id) => introduced.has(`core:${id}`));
  const grammarReached = reachedOrder(grammar, (id) => introduced.has(`grammar:${id}`));
  return {
    unit: unitOfNextGrammar(grammar, new Set(introduced.keys())),
    chapter: chapterInfo(learned.kanjiIntroduced, kanaIntroduced, basic.length).chapter,
    kanjiCanWrite: learned.kanjiCanWrite,
    kanjiCanRead: learned.kanjiCanRead,
    wordsKnown: learned.wordsLearned,
    grammarKnown: learned.grammarLearned,
    hoursTotal: Math.round(hours * 10) / 10,
    daysThisMonth: habits.daysThisMonth,
    longestStreak: habits.longest,
    readyStories,
    recentKanji: recentItemIds(items, today, new Set(['kanji'])).map((id) => id.slice('kanji:'.length)),
    recentItems: recentItemIds(items, today, new Set(['core', 'word', 'grammar', 'kanji']), taskTargets),
    settledUnit: settledUnitFrom(grammar, introduced, today),
    coreReached,
    grammarReached,
  };
}
