// Role-plays waiting for a partner to join. A phone waiting for its partner
// repeats its 'waiting' state every few seconds, so an invite that hasn't been
// repeated for a while is treated as gone. (Who is online: usePresence in
// src/sync/socket.ts.)

import { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { RolePlaySyncState } from '../../../shared/api.ts';
import { onServerEvent } from '../../sync/socket.ts';

export interface RolePlayInvite {
  memberId: string;
  state: RolePlaySyncState;
  /** When the invite was last repeated (ms epoch). */
  at: number;
}

export const INVITE_TTL_MS = 10_000;

let invites: RolePlayInvite[] = [];
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const cb of [...listeners]) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

onServerEvent((ev) => {
  if (ev.type === 'presence' && !ev.online) {
    invites = invites.filter((i) => i.memberId !== ev.memberId);
    changed();
  } else if (ev.type === 'roleplay') {
    const others = invites.filter((i) => i.memberId !== ev.memberId);
    invites = ev.state.status === 'waiting' ? [...others, { memberId: ev.memberId, state: ev.state, at: Date.now() }] : others;
    changed();
  }
});

/** A partner's role-play waiting to be joined (for one script, or any), while it is fresh. */
export function useRolePlayInvite(scriptId?: string): RolePlayInvite | undefined {
  useSyncExternalStore(subscribe, () => version);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const invite = invites.find((i) => (!scriptId || i.state.scriptId === scriptId) && now - i.at < INVITE_TTL_MS);
  // Re-render when this invite goes stale, so the offer disappears on time.
  useEffect(() => {
    if (!invite) return;
    const t = setTimeout(tick, Math.max(0, invite.at + INVITE_TTL_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [invite]);
  return invite;
}

/** Forget an invite once it has been joined or turned down. */
export function dismissInvite(sessionId: string): void {
  const before = invites.length;
  invites = invites.filter((i) => i.state.sessionId !== sessionId);
  if (invites.length !== before) changed();
}

/** For tests. */
export function resetLive(): void {
  invites = [];
  changed();
}
