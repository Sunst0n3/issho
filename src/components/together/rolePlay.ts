// Role-play logic shared by the list, the Together card and the run screen:
// which level fits the learner's phase, tonight's pick, and the run state that
// two phones keep in step over the socket.

import type { RolePlaySyncState } from '../../../shared/api.ts';
import type { RolePlay } from '../../lib/types.ts';

export type Level = RolePlay['level'];

export function levelForPhase(phase: number): Level {
  return phase <= 1 ? 1 : phase === 2 ? 2 : 3;
}

export const LEVEL_NAMES: Record<Level, string> = { 1: 'Starter', 2: 'Everyday', 3: 'Going further' };

/**
 * Tonight's role-play: one at the learner's level that hasn't been done lately
 * (never-done first, in course order, then the longest ago). Falls back to
 * lower levels when a level has no scripts.
 */
export function pickTonight(scripts: readonly RolePlay[], level: Level, history: Record<string, number>): RolePlay | undefined {
  for (let l = level; l >= 1; l--) {
    const atLevel = scripts.filter((s) => s.level === l);
    if (!atLevel.length) continue;
    return [...atLevel].sort((a, b) => (history[a.id] ?? 0) - (history[b.id] ?? 0))[0];
  }
  return scripts[0];
}

// ---- A run -------------------------------------------------------------------

export type Role = 'a' | 'b';
/** Which lines this phone speaks: one role, or both (passing one phone back and forth). */
export type Part = Role | 'both';
export type RunMode = 'solo' | 'duo';
export type RunStep = 'setup' | 'waiting' | 'active' | 'done';

export interface RunState {
  step: RunStep;
  mode: RunMode;
  part: Part;
  sessionId: string;
  lineIndex: number;
  /** Bumps on every restart so per-line UI (revealed text, speech results) resets. */
  round: number;
  /** In two-phone mode: the partner's phone has joined this session. */
  joined: boolean;
}

export type RunAction =
  | { type: 'mode'; mode: RunMode }
  | { type: 'part'; part: Part }
  /** Solo starts at once; two-phone waits for the partner. */
  | { type: 'start'; sessionId: string }
  /** Join a session the partner's phone started, taking the other role. */
  | { type: 'join'; state: RolePlaySyncState }
  | { type: 'next'; total: number }
  | { type: 'again'; swap: boolean }
  | { type: 'solo' }
  | { type: 'cancel' }
  | { type: 'remote'; state: RolePlaySyncState; total: number };

export const other = (role: Role): Role => (role === 'a' ? 'b' : 'a');

export function initialRun(): RunState {
  return { step: 'setup', mode: 'solo', part: 'a', sessionId: '', lineIndex: 0, round: 0, joined: false };
}

export function runReducer(s: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'mode':
      // "Both parts" only makes sense on one phone.
      return { ...s, mode: action.mode, part: action.mode === 'duo' && s.part === 'both' ? 'a' : s.part };
    case 'part':
      return { ...s, part: action.part };
    case 'start':
      return {
        ...s,
        sessionId: action.sessionId,
        step: s.mode === 'duo' ? 'waiting' : 'active',
        lineIndex: 0,
        round: s.round + 1,
        joined: false,
      };
    case 'join':
      return {
        ...s,
        mode: 'duo',
        part: other(action.state.role),
        sessionId: action.state.sessionId,
        step: 'active',
        lineIndex: action.state.lineIndex,
        round: s.round + 1,
        joined: true,
      };
    case 'next': {
      if (s.step !== 'active') return s;
      const lineIndex = Math.min(action.total, s.lineIndex + 1);
      return { ...s, lineIndex, step: lineIndex >= action.total ? 'done' : 'active' };
    }
    case 'again':
      return {
        ...s,
        part: action.swap && s.part !== 'both' ? other(s.part) : s.part,
        step: 'active',
        lineIndex: 0,
        round: s.round + 1,
      };
    case 'solo':
      return { ...s, mode: 'solo', step: 'active', sessionId: '', lineIndex: 0, round: s.round + 1, joined: false };
    case 'cancel':
      return { ...s, step: 'setup', sessionId: '', lineIndex: 0, joined: false };
    case 'remote':
      return applyRemote(s, action.state, action.total);
  }
}

/** The partner's phone changed something in our shared session. */
function applyRemote(s: RunState, remote: RolePlaySyncState, total: number): RunState {
  if (s.mode !== 'duo' || s.step === 'setup' || remote.sessionId !== s.sessionId) return s;
  let next = s;
  // They took our role (swapped roles for another go, or both picked the same one): take the other.
  if (s.part !== 'both' && remote.role === s.part) next = { ...next, part: other(remote.role) };
  if (remote.status === 'done') {
    return next.step === 'active' ? { ...next, step: 'done', lineIndex: total, joined: true } : next;
  }
  if (remote.status !== 'active') return next;
  if (next.step === 'waiting') {
    return { ...next, step: 'active', lineIndex: Math.min(remote.lineIndex, total - 1), joined: true };
  }
  if (next.step === 'done' && remote.lineIndex === 0) {
    return { ...next, step: 'active', lineIndex: 0, round: next.round + 1, joined: true };
  }
  if (next.step === 'active' && remote.lineIndex > next.lineIndex) {
    const lineIndex = Math.min(remote.lineIndex, total);
    return { ...next, lineIndex, step: lineIndex >= total ? 'done' : 'active', joined: true };
  }
  return next.joined ? next : { ...next, joined: true };
}

/** What this phone tells the partner's phone about the session. */
export function syncStateOf(s: RunState, scriptId: string): RolePlaySyncState | null {
  if (s.mode !== 'duo' || s.step === 'setup' || !s.sessionId || s.part === 'both') return null;
  return {
    sessionId: s.sessionId,
    scriptId,
    role: s.part,
    lineIndex: s.lineIndex,
    status: s.step === 'waiting' ? 'waiting' : s.step === 'done' ? 'done' : 'active',
  };
}

/** Whose turn a line is from this phone's point of view. */
export function isMyLine(part: Part, role: Role): boolean {
  return part === 'both' || part === role;
}
