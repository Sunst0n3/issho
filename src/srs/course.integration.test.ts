// Integration: course days 1 → 24 through the real planner, course and scheduler
// (data from the fixtures), as a learner who does every step of every sitting.
// Also design §5.2 test 7: a v2 backup restored onto a reset device plans the same day.

import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBackup, importBackup } from '../lib/backup.ts';
import { dayKey, db, updateSettings } from '../lib/db.ts';
import { introducePlanItem } from './course.ts';
import { completeDay } from './habits.ts';
import { planToday, startSitting } from './planner.ts';
import { gradeCard } from './scheduler.ts';
import { at, BASIC_HIRAGANA, BASIC_KATAKANA, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

interface DayLog { courseDay: number; date: string; mode: string; introduced: string[] }

/** Studies `days` consecutive calendar days from 2026-03-02; on `reviewOnly` course days the teach step is skipped. */
async function run(days: number, reviewOnly: ReadonlySet<number> = new Set()): Promise<DayLog[]> {
  const out: DayLog[] = [];
  for (let i = 0; i < days; i++) {
    const now = at(2026, 3, 2 + i, 9);
    const plan = await planToday(now);
    await startSitting(plan, now);
    let t = now.getTime();
    const tick = () => new Date((t += 20_000));
    for (const id of plan.warmup) await gradeCard(id, Rating.Good, { durationMs: 8000, mode: 'typed', now: tick() });
    const introduced: string[] = [];
    if (!reviewOnly.has(plan.courseDay)) {
      for (const batch of plan.teach) {
        for (const item of batch.items) {
          const results = await introducePlanItem(item, tick());
          if (results[0]?.created) introduced.push(item.itemId);
        }
      }
    }
    const fresh = await db.cards.where('state').equals(State.New).toArray();
    for (const card of fresh) await gradeCard(card.id, Rating.Good, { durationMs: 6000, mode: 'typed', context: 'first-check', now: tick() });
    await completeDay(tick());
    out.push({ courseDay: plan.courseDay, date: dayKey(now), mode: plan.mode, introduced });
  }
  return out;
}

const on = (log: DayLog[], courseDay: number) => log.find((d) => d.courseDay === courseDay)!.introduced;
const kanaOf = (ids: string[]) => ids.filter((id) => id.startsWith('kana:')).map((id) => id.slice(5)).join('');

describe('course days 1 → 24', () => {
  it('runs the sprint, then kanji with anchors and staged words', { timeout: 120_000 }, async () => {
    const log = await run(24);
    expect(log.map((d) => d.courseDay)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(kanaOf(on(log, 1))).toBe('あいうえおかきくけこ');
    expect(kanaOf(on(log, 5))).toBe('らりるれろわをん');
    expect(kanaOf(log.filter((d) => d.courseDay <= 5).flatMap((d) => d.introduced))).toBe(BASIC_HIRAGANA.join(''));
    expect(kanaOf(log.filter((d) => d.courseDay >= 8 && d.courseDay <= 12).flatMap((d) => d.introduced))).toBe(BASIC_KATAKANA.join(''));
    expect(on(log, 6)).toContain('kanaRule:hira-dakuten');
    expect(on(log, 7)).toContain('kanaRule:hira-yoon');
    expect(on(log, 13)).toContain('kanaRule:kata-dakuten-yoon');
    expect(on(log, 14)).toContain('kanaRule:kata-extended');

    expect(on(log, 2).some((id) => id.startsWith('core:'))).toBe(false);
    expect(on(log, 3).filter((id) => id.startsWith('core:'))).toEqual(['core:cw-0001', 'core:cw-0002', 'core:cw-0003']);
    expect(log.find((d) => d.introduced.some((id) => id.startsWith('grammar:')))?.courseDay).toBe(8);
    expect(log.filter((d) => d.courseDay < 15).every((d) => d.mode === 'sprint')).toBe(true);

    expect(log.find((d) => d.introduced.some((id) => id.startsWith('kanji:')))?.courseDay).toBe(15);
    expect(on(log, 15).filter((id) => id.startsWith('kanji:'))).toEqual(['kanji:一', 'kanji:二', 'kanji:三']);
    expect(dayKey((await db.items.get('word:2001'))!.introducedAt)).toBe(log[14].date);

    // 一's staged word: released 3 calendar days later (course day 18).
    expect(dayKey((await db.items.get('word:2002'))!.introducedAt)).toBe(log[17].date);
    expect((await db.items.get('word:2002'))?.via).toBe('staged');
    // 日's words: +3 and +8 calendar days after 日.
    const hi = dayKey((await db.items.get('kanji:日'))!.introducedAt);
    const hiDay = log.findIndex((d) => d.date === hi);
    expect(dayKey((await db.items.get('word:1002'))!.introducedAt)).toBe(log[hiDay + 3].date);
    expect(dayKey((await db.items.get('word:1008'))!.introducedAt)).toBe(log[hiDay + 8].date);

    // Every New card was checked; nothing was introduced twice.
    expect(await db.cards.where('state').equals(State.New).count()).toBe(0);
    const all = log.flatMap((d) => d.introduced);
    expect(new Set(all).size).toBe(all.length);
  });

  it('teaches a row skipped by a review-only day the next day, and starts kanji after the last sprint item', { timeout: 120_000 }, async () => {
    const sprintOf = (log: DayLog[]) => log.flatMap((d) => d.introduced).filter((id) => id.startsWith('kana:') || id.startsWith('kanaRule:'));
    const lastSprintDay = (log: DayLog[]) =>
      Math.max(...log.filter((d) => d.introduced.some((id) => id.startsWith('kana:') || id.startsWith('kanaRule:'))).map((d) => d.courseDay));
    const firstKanjiDay = (log: DayLog[]) => log.find((d) => d.introduced.some((id) => id.startsWith('kanji:')))!.courseDay;

    // One review-only day: the slack of the 8-kana days and the rule days absorbs it.
    const one = await run(17, new Set([4]));
    expect(kanaOf(on(one, 4))).toBe('');
    expect(kanaOf(on(one, 5))).toBe('まみむめもやゆよらり');
    expect(sprintOf(one)).toHaveLength(92 + 4);
    expect(new Set(sprintOf(one)).size).toBe(96);
    expect(firstKanjiDay(one)).toBe(Math.max(15, lastSprintDay(one) + 1));

    // Four review-only days push the sprint past day 14; kanji wait for its last item.
    await resetDb();
    const four = await run(22, new Set([2, 3, 4, 5]));
    expect(new Set(sprintOf(four)).size).toBe(96);
    expect(sprintOf(four)).toHaveLength(96);
    expect(lastSprintDay(four)).toBeGreaterThan(14);
    expect(firstKanjiDay(four)).toBe(lastSprintDay(four) + 1);
    expect(four.filter((d) => d.courseDay <= lastSprintDay(four)).every((d) => d.mode === 'sprint')).toBe(true);
  });
});

describe('backup round trip', () => {
  it('export → reset → import gives the same plan', { timeout: 120_000 }, async () => {
    await updateSettings({ name: 'Carter', onboarded: true, dailyMinutes: 25 });
    await run(17);
    const now = at(2026, 3, 19, 9); // course day 18: kanji, staged releases and reviews due
    const before = await planToday(now);
    expect(before.courseDay).toBe(18);
    expect(before.mode).toBe('normal');
    expect(before.warmup.length).toBeGreaterThan(0);

    const file = await exportBackup();
    await resetDb();
    expect(await db.items.count()).toBe(0);
    const restore = await importBackup(file);
    expect(restore.progressDropped).toBe(false);
    await restore.apply();

    expect(await planToday(now)).toEqual(before);
  });
});
