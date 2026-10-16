// Entry point for the together features. startSync() runs once at app start and
// keeps everything in step with the pairing in settings: it (re)connects the
// socket when the server address or token changes, delivers queued messages and
// together events, catches up on chat, and shares study stats whenever today's
// progress changes.

import { liveQuery } from 'dexie';
import { startServerBackups } from './backups.ts';
import { db, DEFAULT_SETTINGS } from '../lib/db.ts';
import type { DayRecord } from '../lib/types.ts';
import { socketUrl } from './client.ts';
import { startChat, syncMessages } from './chat.ts';
import { flushOutbox, startOutbox } from './outbox.ts';
import { connectSocket, disconnectSocket } from './socket.ts';
import { flushPendingStats, pushStats, refreshHousehold, resetHousehold, startHousehold } from './stats.ts';
import { flushTogetherOutbox, refreshTogether, resetTogether, startTogetherSync } from './together.ts';

let stopSync: (() => void) | null = null;

export function startSync(): () => void {
  if (stopSync) return stopSync;

  const stops = [startOutbox(), startChat(), startHousehold(), startTogetherSync(), startServerBackups()];

  let pairing: string | undefined;
  const settingsSub = liveQuery(() => db.settings.get('me')).subscribe({
    next: (stored) => {
      const url = socketUrl({ ...DEFAULT_SETTINGS, ...stored });
      const key = url ?? '';
      if (key === pairing) return;
      const changed = pairing !== undefined;
      pairing = key;
      connectSocket(url);
      // A different (or no) pairing means the cached household belongs to someone else.
      if (changed) {
        resetHousehold();
        resetTogether();
      }
      if (!url) return;
      void flushOutbox();
      void flushTogetherOutbox();
      syncMessages().catch(() => {});
      void refreshHousehold();
      void refreshTogether();
      void pushStats({ immediate: true });
    },
    error: (e) => console.error('settings watch failed', e),
  });

  // Today's DayRecord changes on every graded card and at session end. Share it:
  // debounced while studying, at once when the day becomes a minimum day or its
  // goal is met. Watching the two newest rows also catches the 4 a.m. rollover.
  let lastDays: DayRecord[] | undefined;
  const daysSub = liveQuery(() => db.days.orderBy('date').reverse().limit(2).toArray()).subscribe({
    next: (days) => {
      const prev = lastDays;
      lastDays = days;
      if (!prev || JSON.stringify(days) === JSON.stringify(prev)) return;
      const reached = (d: DayRecord, flag: 'minimumDone' | 'goalMet') =>
        Boolean(d[flag]) && !prev.find((p) => p.date === d.date)?.[flag];
      const milestone = days.some((d) => reached(d, 'minimumDone') || reached(d, 'goalMet'));
      void pushStats({ immediate: milestone });
    },
    error: (e) => console.error('progress watch failed', e),
  });

  // iOS may suspend the page soon after it is hidden; don't sit on a pending upload.
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushPendingStats(); };
  document.addEventListener('visibilitychange', onVisibility);

  stopSync = () => {
    settingsSub.unsubscribe();
    daysSub.unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    stops.forEach((stop) => stop());
    disconnectSocket();
    stopSync = null;
  };
  return stopSync;
}
