// Learning snapshots are separate from aggregate partner stats. A pending request survives offline launches.
import { liveQuery } from 'dexie';
import { exportBackup } from '../lib/backup.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import { isPairedSettings, onServerReachable, pairingOwner, samePairingOwner, uploadBackup } from './client.ts';

let running: Promise<void> | undefined;

/** Called after a sitting; failures leave the request pending without blocking the learner. */
export async function requestServerBackup(now = new Date()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const s = await getSettings();
    const previous = Date.parse(s.serverBackupRequestedAt ?? '') || 0;
    const requestedAt = new Date(Math.max(now.getTime(), previous + 1)).toISOString();
    await updateSettings({ serverBackupRequestedAt: requestedAt, serverBackupPending: true, serverBackupOwner: pairingOwner(s) });
  });
  await flushServerBackup();
}

export function flushServerBackup(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const s = await getSettings();
    if (!s.serverBackupPending || !isPairedSettings(s)) return;
    const owner = pairingOwner(s);
    if (s.serverBackupOwner && !samePairingOwner(s.serverBackupOwner, owner)) return;
    try {
      const file = await exportBackup();
      const backup = JSON.parse(await file.text()) as { tables: Record<string, unknown[]> };
      // Chat and outgoing events already have server persistence; restoring a snapshot must not re-send them.
      for (const key of ['messages', 'outbox', 'togetherOutbox']) backup.tables[key] = [];
      const saved = await uploadBackup(backup, owner);
      await db.transaction('rw', db.settings, async () => {
        const current = await getSettings();
        if (!samePairingOwner(owner, pairingOwner(current))) return;
        await updateSettings({ serverBackupCompletedAt: saved.createdAt,
          serverBackupPending: current.serverBackupRequestedAt !== s.serverBackupRequestedAt,
          serverBackupOwner: owner });
      });
    } catch {
      // The server may be offline or older than the backup API. Manual export remains available.
    }
  })().finally(() => { running = undefined; });
  return running;
}

/** Retry on pairing, a reachable server, foregrounding, and while an offline request is waiting. */
export function startServerBackups(): () => void {
  const flush = () => { void flushServerBackup(); };
  const stopReachable = onServerReachable(flush);
  let lastPairing = '';
  const sub = liveQuery(getSettings).subscribe((s) => {
    const key = `${s.serverUrl ?? ''}|${s.deviceToken ?? ''}`;
    if (key !== lastPairing) { lastPairing = key; flush(); }
  });
  const visible = () => { if (document.visibilityState === 'visible') flush(); };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', visible);
  const timer = setInterval(flush, 60_000);
  flush();
  return () => {
    sub.unsubscribe(); stopReachable(); clearInterval(timer);
    window.removeEventListener('online', flush); document.removeEventListener('visibilitychange', visible);
  };
}
