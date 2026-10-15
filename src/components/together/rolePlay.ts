// Role-play logic shared by the list, the Together screens and the run screens:
// tonight's pick, the conversation stages S1–S4 of a core conversation, and the
// run state that two phones keep in step over the socket.

import type { RolePlaySyncState, VoiceId } from '../../../shared/api.ts';
import { clipRef } from '../../../shared/voicevox.ts';
import type { RolePlay, RolePlayLine } from '../../lib/types.ts';

export type Level = RolePlay['level'];

export const LEVEL_NAMES: Record<Level, string> = { 1: 'Starter', 2: 'Everyday', 3: 'Going further' };

/** A free role-play to suggest: never-done first (in list order), then the one done longest ago. */
export function pickTonight(scripts: readonly RolePlay[], history: Record<string, number>): RolePlay | undefined {
  return [...scripts].sort((a, b) => (history[a.id] ?? 0) - (history[b.id] ?? 0))[0];
}

// ---- Conversation stages -------------------------------------------------------

/**
 * S1 listen to the model audio and shadow, S2 perform from the Japanese (English behind a tap),
 * S3 swap roles, S4 keyword cue cards only.
 */
export type Stage = 1 | 2 | 3 | 4;

export const STAGE_NAMES: Record<Stage, string> = {
  1: 'Listen and shadow',
  2: 'Perform from the Japanese',
  3: 'Swap roles',
  4: 'Cue cards only',
};

export interface StageState {
  scriptId: string;
  stage: Stage;
  /** memberId → marked this stage smooth. */
  smooth: Record<string, boolean>;
  /** Stage 4 was marked smooth by everyone: the conversation is done. */
  finished: boolean;
}

export type StageAction =
  | { type: 'smooth'; memberId: string; members: readonly string[] }
  | { type: 'again' }
  /** The server's view: the script's stage and who marked it smooth (TogetherState.stages / smooth). */
  | { type: 'sync'; stage: number; smooth: readonly string[] };

export function initialStage(scriptId: string, stage: number): StageState {
  return { scriptId, stage: toStage(stage), smooth: {}, finished: stage > 4 };
}

function toStage(stage: number): Stage {
  return Math.min(4, Math.max(1, Math.trunc(stage) || 1)) as Stage;
}

/** Advances only when every member in `members` marked smooth; stage 4 smooth → finished. */
export function stageReducer(s: StageState, a: StageAction): StageState {
  switch (a.type) {
    case 'smooth': {
      if (s.finished) return s;
      const smooth = { ...s.smooth, [a.memberId]: true };
      if (!a.members.every((m) => smooth[m])) return { ...s, smooth };
      return s.stage === 4 ? { ...s, smooth: {}, finished: true } : { ...s, stage: (s.stage + 1) as Stage, smooth: {} };
    }
    case 'again':
      return { ...s, smooth: {} };
    case 'sync': {
      if (a.stage > 4) return { ...s, smooth: {}, finished: true };
      const stage = toStage(a.stage);
      // Never step back below what this phone already reached: the server catches up.
      if (stage < s.stage) return s;
      const smooth = stage === s.stage ? { ...s.smooth } : {};
      for (const m of a.smooth) smooth[m] = true;
      return { ...s, stage, smooth, finished: false };
    }
  }
}

/** English is hidden from S2 on (behind a tap). */
export function englishHidden(stage: Stage): boolean {
  return stage >= 2;
}

/** Roles swap at S3. */
export function swapRoles(stage: Stage): boolean {
  return stage === 3;
}

/** S4 shows keyword cue cards only. */
export function cueOnly(stage: Stage): boolean {
  return stage === 4;
}

/** A line's cue card: its authored keywords, else the first three English words. */
export function cueOf(line: Pick<RolePlayLine, 'cue' | 'en'>): string {
  const cue = line.cue?.trim();
  if (cue) return cue;
  return line.en.split(/\s+/).filter(Boolean).slice(0, 3).join(' ').replace(/[.,!?;:]+$/, '');
}

/** The clip of a role-play line: role a speaks with the main voice, role b with the second. */
export function lineClip(scriptId: string, index: number, line: Pick<RolePlayLine, 'role' | 'jp'>) {
  return { ref: clipRef.rolePlay(scriptId, index), voice: line.role === 'a' ? ('f' as const) : ('m' as const), text: line.jp };
}

/** Words in a task's AI role that make the persona a woman ('The party host, Ms. Yamada, … herself', 'Yuki, … she'). */
const WOMAN_RE = /\b(?:Ms|Mrs|Miss)\b\.?|\b(?:she|her|hers|herself|woman|lady|girl|mother|wife|sister|aunt|grandmother)\b/i;

/**
 * The voice of the AI persona in Session B: the woman's voice ('f') for a persona the task describes as a woman, the
 * man's ('m') otherwise, so Ms. Yamada and Yuki don't speak in a man's voice.
 */
export function personaVoice(aiRole: string | undefined): VoiceId {
  return aiRole && WOMAN_RE.test(aiRole) ? 'f' : 'm';
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
export function syncStateOf(s: RunState, scriptId: string, stage?: Stage): RolePlaySyncState | null {
  if (s.mode !== 'duo' || s.step === 'setup' || !s.sessionId || s.part === 'both') return null;
  return {
    sessionId: s.sessionId,
    scriptId,
    role: s.part,
    lineIndex: s.lineIndex,
    status: s.step === 'waiting' ? 'waiting' : s.step === 'done' ? 'done' : 'active',
    ...(stage ? { stage } : {}),
  };
}

/** Whose turn a line is from this phone's point of view. */
export function isMyLine(part: Part, role: Role): boolean {
  return part === 'both' || part === role;
}
