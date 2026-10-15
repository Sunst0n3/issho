import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import type { CanDo, UnitSpec } from '../lib/types.ts';
import { canDoAvailable, canDoStatus, gradeCanDoQuestions, recordCanDoAttempt } from './candos.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

const question = (answer: number) => ({ q: '?', options: ['a', 'b', 'c'], answer });
const canDo = (kind: CanDo['check']['kind'], n: number, ready = true): CanDo => ({
  id: 'u01-cd1', text: 'Greet people', ready,
  check: { kind, instructions: '', material: '', questions: Array.from({ length: n }, (_, i) => question(i % 3)) },
});
const unit = { id: 1, grammar: ['wa-desu', 'ka-question'] } as UnitSpec;

describe('gradeCanDoQuestions', () => {
  it('passes with at least two thirds right', () => {
    const three = canDo('read', 3);
    expect(gradeCanDoQuestions(three, [0, 1, 0])).toEqual({ correct: 2, passed: true });
    expect(gradeCanDoQuestions(three, [0, 0, 0])).toEqual({ correct: 1, passed: false });
    const two = canDo('listen', 2);
    expect(gradeCanDoQuestions(two, [0, 1])).toEqual({ correct: 2, passed: true });
    expect(gradeCanDoQuestions(two, [0, 2])).toEqual({ correct: 1, passed: false });
  });

  it('never passes a speak or write check here', () => {
    expect(gradeCanDoQuestions(canDo('speak', 0), []).passed).toBe(false);
  });
});

describe('canDoAvailable', () => {
  it('needs the content ready and the unit’s grammar introduced', () => {
    expect(canDoAvailable(canDo('read', 3), unit, new Set(['wa-desu']))).toBe(false);
    expect(canDoAvailable(canDo('read', 3), unit, new Set(['wa-desu', 'ka-question']))).toBe(true);
    expect(canDoAvailable(canDo('read', 3, false), unit, new Set(['wa-desu', 'ka-question']))).toBe(false);
  });
});

describe('recordCanDoAttempt', () => {
  it('counts attempts and awards only a passed check', async () => {
    const failed = await recordCanDoAttempt('u01-cd1', 1, false, 'auto', at(2026, 3, 1));
    expect(failed).toEqual({ id: 'u01-cd1', unit: 1, attempts: 1 });
    const passed = await recordCanDoAttempt('u01-cd1', 1, true, 'auto', at(2026, 3, 2));
    expect(passed).toMatchObject({ attempts: 2, passedAt: at(2026, 3, 2), via: 'auto' });
    await recordCanDoAttempt('u01-cd1', 1, false, 'auto', at(2026, 3, 3));
    expect((await canDoStatus()).get('u01-cd1')).toMatchObject({ attempts: 3, passedAt: at(2026, 3, 2) });
  });

  it("accepts only a check, 'auto' or 'ai'", async () => {
    await expect(recordCanDoAttempt('u01-cd2', 1, true, 'partner' as 'ai')).rejects.toThrow(TypeError);
    expect(await db.canDos.count()).toBe(0);
  });
});
