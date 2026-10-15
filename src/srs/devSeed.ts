// DEV only: seeds this device as if the learner had studied up to course day N,
// by running the simulator on the real course and writing its final state.
// Never reached from production code (window.__issho.devSeed in a DEV build).

import { dayKey, db, getSettings, updateSettings } from '../lib/db.ts';
import type { DailyMinutes } from '../lib/types.ts';
import { addDays } from './days.ts';
import { loadSimCourse, simulate } from './simulate.ts';

/** Tables holding learning progress (settings, pairing, chat and outboxes are kept). */
const PROGRESS = [
  'items', 'cards', 'reviewLogs', 'days', 'savedSentences', 'encounters', 'shownSentences', 'staged', 'stories',
  'restTokens', 'outputs', 'canDos', 'milestones', 'togetherPlans', 'partnerQuizzes', 'pitchBoxes', 'fluency',
] as const;

/**
 * Wipes the progress tables, runs simulate({ course: await loadSimCourse(), days: courseDay − 1, startDate: dayKey(now) −
 * (courseDay − 1) days, keepState: true }) and writes its state, so that today is course day N with real kanji, core
 * and grammar ids.
 */
export async function devSeed(courseDay: number, opts: { budgetMin?: DailyMinutes; seed?: number } = {}, now: Date = new Date()): Promise<void> {
  if (!import.meta.env.DEV) throw new Error('devSeed is only available in a development build');
  if (!Number.isInteger(courseDay) || courseDay < 1) throw new RangeError(`Course day must be a whole number ≥ 1, not ${courseDay}`);
  const settings = await getSettings();
  const course = await loadSimCourse();
  const days = courseDay - 1;
  const { state } = simulate({
    course,
    budgetMin: opts.budgetMin ?? settings.dailyMinutes,
    days,
    seed: opts.seed ?? 1,
    startDate: addDays(dayKey(now), -days),
    writeList: settings.writeList,
    keepState: true,
  });
  await db.transaction('rw', PROGRESS.map((name) => db.table(name)), async () => {
    for (const name of PROGRESS) await db.table(name).clear();
    if (!state) return;
    await db.items.bulkPut(state.items);
    await db.cards.bulkPut(state.cards);
    await db.reviewLogs.bulkAdd(state.logs);
    await db.days.bulkPut(state.days);
    await db.staged.bulkPut(state.staged);
  });
  await updateSettings({ onboarded: true, knowsHiragana: false, knowsKatakana: false });
}
