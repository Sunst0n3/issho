// Can-dos: unit goals awarded only by a passed check. read/listen checks are
// graded here; speak/write checks only by the home server's AI. There is no
// self-rating and no partner rubric.

import { db } from '../lib/db.ts';
import type { CanDo, CanDoRecord, UnitSpec } from '../lib/types.ts';

/** pure: ready, and every grammar id of its unit is introduced. */
export function canDoAvailable(cd: CanDo, unit: UnitSpec, grammarIntroduced: ReadonlySet<string>): boolean {
  return cd.ready && unit.grammar.every((g) => grammarIntroduced.has(g));
}

/** pure: read/listen checks pass with correct ≥ ceil(2/3 · n) (2 of 2, 2 of 3). */
export function gradeCanDoQuestions(cd: CanDo, answers: readonly number[]): { correct: number; passed: boolean } {
  const questions = cd.check.questions;
  const correct = questions.filter((q, i) => answers[i] === q.answer).length;
  const auto = cd.check.kind === 'read' || cd.check.kind === 'listen';
  return { correct, passed: auto && questions.length > 0 && correct >= Math.ceil((2 / 3) * questions.length) };
}

const VIAS: ReadonlySet<string> = new Set(['auto', 'ai']);

/** Records an attempt; sets passedAt only when passed. There is no API that awards a can-do without a check (no self-rating). */
export function recordCanDoAttempt(id: string, unit: number, passed: boolean, via: 'auto' | 'ai', now: Date = new Date()): Promise<CanDoRecord> {
  if (!VIAS.has(via)) return Promise.reject(new TypeError(`A can-do is awarded only by a check ('auto' or 'ai'), not "${via}"`));
  return db.transaction('rw', db.canDos, async () => {
    const row: CanDoRecord = (await db.canDos.get(id)) ?? { id, unit, attempts: 0 };
    const next: CanDoRecord = { ...row, unit, attempts: row.attempts + 1 };
    if (passed && !row.passedAt) {
      next.passedAt = now;
      next.via = via;
    }
    await db.canDos.put(next);
    return next;
  });
}

export async function canDoStatus(): Promise<Map<string, CanDoRecord>> {
  return new Map((await db.canDos.toArray()).map((r) => [r.id, r]));
}
