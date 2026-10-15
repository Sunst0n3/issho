import { describe, expect, it } from 'vitest';
import type { RolePlaySyncState } from '../../../shared/api.ts';
import type { RolePlay } from '../../lib/types.ts';
import {
  cueOf,
  cueOnly,
  englishHidden,
  initialRun,
  initialStage,
  lineClip,
  personaVoice,
  pickTonight,
  runReducer,
  stageReducer,
  swapRoles,
  syncStateOf,
  type RunState,
  type Stage,
} from './rolePlay.ts';

const script = (id: string, level: 1 | 2 | 3): RolePlay => ({
  id, level, title: id, titleJp: id, setting: '', lines: [], register: 'plain', targets: [],
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
  it('picks the script done longest ago, never-done first', () => {
    const scripts = [script('b', 2), script('c', 2), script('d', 2)];
    expect(pickTonight(scripts, {})?.id).toBe('b');
    expect(pickTonight(scripts, { b: 300, c: 100 })?.id).toBe('d');
    expect(pickTonight(scripts, { b: 300, c: 100, d: 200 })?.id).toBe('c');
    expect(pickTonight([], {})).toBeUndefined();
  });
});

describe('conversation stages', () => {
  const members = ['me', 'partner'];

  it('advances only when both partners mark the stage smooth', () => {
    let s = initialStage('rp-u01', 1);
    s = stageReducer(s, { type: 'smooth', memberId: 'me', members });
    expect(s).toMatchObject({ stage: 1, smooth: { me: true }, finished: false });
    // Marking twice changes nothing.
    s = stageReducer(s, { type: 'smooth', memberId: 'me', members });
    expect(s.stage).toBe(1);
    s = stageReducer(s, { type: 'smooth', memberId: 'partner', members });
    expect(s).toMatchObject({ stage: 2, smooth: {}, finished: false });
  });

  it('clears the marks on "again next time"', () => {
    let s = stageReducer(initialStage('x', 2), { type: 'smooth', memberId: 'me', members });
    s = stageReducer(s, { type: 'again' });
    expect(s).toMatchObject({ stage: 2, smooth: {} });
  });

  it('finishes after stage 4', () => {
    let s = initialStage('x', 4);
    for (const m of members) s = stageReducer(s, { type: 'smooth', memberId: m, members });
    expect(s).toMatchObject({ stage: 4, finished: true });
    expect(initialStage('x', 5).finished).toBe(true);
  });

  it('follows the server forward, never back', () => {
    let s = stageReducer(initialStage('x', 1), { type: 'sync', stage: 1, smooth: ['partner'] });
    expect(s.smooth).toEqual({ partner: true });
    s = stageReducer(s, { type: 'smooth', memberId: 'me', members });
    expect(s.stage).toBe(2);
    expect(stageReducer(s, { type: 'sync', stage: 1, smooth: [] }).stage).toBe(2);
    expect(stageReducer(s, { type: 'sync', stage: 3, smooth: [] }).stage).toBe(3);
    expect(stageReducer(s, { type: 'sync', stage: 5, smooth: [] }).finished).toBe(true);
  });

  it('hides English at S2–S4, swaps roles at S3 and shows cue cards only at S4', () => {
    const stages: Stage[] = [1, 2, 3, 4];
    expect(stages.map(englishHidden)).toEqual([false, true, true, true]);
    expect(stages.map(swapRoles)).toEqual([false, false, true, false]);
    expect(stages.map(cueOnly)).toEqual([false, false, false, true]);
  });

  it('uses the authored cue, else the first three English words', () => {
    expect(cueOf({ cue: 'coffee · two', en: 'Two coffees, please.' })).toBe('coffee · two');
    expect(cueOf({ cue: '', en: 'Two coffees, please.' })).toBe('Two coffees, please');
    expect(cueOf({ cue: '', en: 'Where is the station?' })).toBe('Where is the');
  });

  it('plays role a with the main voice and role b with the second', () => {
    expect(lineClip('rp-u01', 3, { role: 'b', jp: 'はい' })).toEqual({ ref: 'rp:rp-u01#3', voice: 'm', text: 'はい' });
    expect(lineClip('rp-u01', 0, { role: 'a', jp: 'ねえ' }).voice).toBe('f');
  });

  it('carries the stage in the shared role-play state', () => {
    const waiting = runReducer({ ...initialRun(), mode: 'duo' }, { type: 'start', sessionId: 'x' });
    expect(syncStateOf(waiting, 'rp', 3)?.stage).toBe(3);
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

describe('personaVoice', () => {
  it('voices a persona the task describes as a woman with the woman\'s voice, any other with the man\'s', () => {
    // The two women among the task AI roles (u01, u05), and others as authored.
    expect(personaVoice('The party host, Ms. Yamada, who greets you both, introduces herself and asks whose umbrella is by the door')).toBe('f');
    expect(personaVoice('Your friend Yuki, who calls to ask whether she can come along and what time to meet')).toBe('f');
    expect(personaVoice('Café clerk who greets you, takes your order, tells you the total and gives you your change')).toBe('m');
    expect(personaVoice('A friendly passer-by near the station, whom the partner on the street can stop and ask the way in polite Japanese (すみません、〜はどこですか).')).toBe('m');
    expect(personaVoice('Restaurant staff on the phone, using polite service Japanese, so that both of you can practise being the caller')).toBe('m');
    // "there", "other" and "together" are not "her".
    expect(personaVoice('Estate agent who answers your other questions there, together')).toBe('m');
    expect(personaVoice(undefined)).toBe('m');
  });
});
