import { describe, expect, it } from 'vitest';
import type { RolePlaySyncState } from '../../../shared/api.ts';
import type { RolePlay } from '../../lib/types.ts';
import { initialRun, levelForPhase, pickTonight, runReducer, syncStateOf, type RunState } from './rolePlay.ts';

const script = (id: string, level: 1 | 2 | 3): RolePlay => ({
  id, level, title: id, titleJp: id, setting: '', lines: [],
  roles: { a: { name: 'A', nameJp: 'え' }, b: { name: 'B', nameJp: 'び' } },
});

const remote = (patch: Partial<RolePlaySyncState>): RolePlaySyncState => ({
  sessionId: 's1', scriptId: 'rp', role: 'a', lineIndex: 0, status: 'active', ...patch,
});

/** A two-phone run in session s1 where this phone plays B. */
function duo(patch: Partial<RunState> = {}): RunState {
  return { ...initialRun(), mode: 'duo', part: 'b', sessionId: 's1', step: 'active', round: 1, joined: true, ...patch };
}

describe('picking role-plays', () => {
  it('maps phases to levels', () => {
    expect([1, 2, 3, 4].map(levelForPhase)).toEqual([1, 2, 3, 3]);
  });

  it("picks the level's script done longest ago, never-done first", () => {
    const scripts = [script('a', 1), script('b', 2), script('c', 2), script('d', 2)];
    expect(pickTonight(scripts, 2, {})?.id).toBe('b');
    expect(pickTonight(scripts, 2, { b: 300, c: 100 })?.id).toBe('d');
    expect(pickTonight(scripts, 2, { b: 300, c: 100, d: 200 })?.id).toBe('c');
  });

  it('falls back to a lower level when one is empty', () => {
    expect(pickTonight([script('a', 1)], 3, {})?.id).toBe('a');
  });
});

describe('runReducer', () => {
  it('starts solo at once and two-phone runs waiting', () => {
    const solo = runReducer(initialRun(), { type: 'start', sessionId: 'x' });
    expect(solo.step).toBe('active');
    const waiting = runReducer({ ...initialRun(), mode: 'duo' }, { type: 'start', sessionId: 'x' });
    expect(waiting.step).toBe('waiting');
    expect(syncStateOf(waiting, 'rp')).toEqual({ sessionId: 'x', scriptId: 'rp', role: 'a', lineIndex: 0, status: 'waiting' });
  });

  it('drops "both parts" when switching to two phones', () => {
    const s = runReducer({ ...initialRun(), part: 'both' }, { type: 'mode', mode: 'duo' });
    expect(s.part).toBe('a');
  });

  it('joins with the other role', () => {
    const s = runReducer(initialRun(), { type: 'join', state: remote({ role: 'a', status: 'waiting' }) });
    expect(s).toMatchObject({ mode: 'duo', part: 'b', sessionId: 's1', step: 'active', joined: true });
  });

  it('starts when the partner joins, and follows their progress forward only', () => {
    let s = runReducer(duo({ step: 'waiting', joined: false, part: 'a' }), { type: 'remote', state: remote({ role: 'b' }), total: 4 });
    expect(s).toMatchObject({ step: 'active', lineIndex: 0, joined: true });
    s = runReducer(s, { type: 'remote', state: remote({ role: 'b', lineIndex: 2 }), total: 4 });
    expect(s.lineIndex).toBe(2);
    s = runReducer(s, { type: 'remote', state: remote({ role: 'b', lineIndex: 1 }), total: 4 });
    expect(s.lineIndex).toBe(2);
  });

  it('ignores other sessions and solo runs', () => {
    expect(runReducer(duo(), { type: 'remote', state: remote({ sessionId: 's2', lineIndex: 3 }), total: 4 }).lineIndex).toBe(0);
    const solo = { ...duo(), mode: 'solo' as const };
    expect(runReducer(solo, { type: 'remote', state: remote({ lineIndex: 3 }), total: 4 })).toBe(solo);
  });

  it('finishes with the partner and restarts with swapped roles', () => {
    let s = runReducer(duo({ lineIndex: 3 }), { type: 'remote', state: remote({ status: 'done', lineIndex: 4 }), total: 4 });
    expect(s.step).toBe('done');
    // The partner swapped to B and went again: this phone becomes A.
    s = runReducer(s, { type: 'remote', state: remote({ role: 'b', lineIndex: 0 }), total: 4 });
    expect(s).toMatchObject({ step: 'active', lineIndex: 0, part: 'a', round: 2 });
  });

  it('advances locally and ends after the last line', () => {
    let s = runReducer(duo({ lineIndex: 2 }), { type: 'next', total: 4 });
    expect(s.lineIndex).toBe(3);
    s = runReducer(s, { type: 'next', total: 4 });
    expect(s.step).toBe('done');
    s = runReducer(s, { type: 'again', swap: true });
    expect(s).toMatchObject({ step: 'active', lineIndex: 0, part: 'a' });
  });
});
