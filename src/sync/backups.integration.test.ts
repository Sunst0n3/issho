import { afterEach, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { importBackup } from '../lib/backup.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import { requestServerBackup } from './backups.ts';
import { getServerBackup, listBackups } from './client.ts';
import { startLiveServer, type LiveServer } from './test-server.ts';

let server: LiveServer | undefined;
afterEach(async () => { await server?.close(); await Promise.all(db.tables.map((t) => t.clear())); });

it('recovers full learning state on a fresh device from the real authenticated server', async () => {
  server = await startLiveServer();
  const me = await server.register('Carter');
  await updateSettings({ name: 'Carter', onboarded: true, serverUrl: server.url, memberId: me.memberId, deviceToken: me.deviceToken });
  const introducedAt = new Date('2026-10-16T02:00:00Z');
  await db.items.put({ id: 'kanji:水', key: '水', kind: 'kanji', introducedAt });
  await db.cards.put({ ...createEmptyCard(introducedAt), id: 'kanji:水|write', itemId: 'kanji:水', kind: 'kanji', type: 'write', stability: 12 });
  await requestServerBackup();
  expect((await getSettings()).serverBackupPending).toBe(false);
  // A replacement phone joins as the same learner and starts with no course database.
  await Promise.all(db.tables.map((t) => t.clear()));
  const replacement = await server.register('Carter');
  await updateSettings({ name: 'Carter', serverUrl: server.url, memberId: replacement.memberId, deviceToken: replacement.deviceToken });
  const snapshots = await listBackups();
  expect(snapshots).toHaveLength(1);
  const restore = await importBackup(await getServerBackup(snapshots[0].id));
  expect(await db.cards.count()).toBe(0);
  await restore.apply();
  expect((await db.cards.get('kanji:水|write'))?.stability).toBe(12);
  expect((await db.items.get('kanji:水'))?.introducedAt).toEqual(introducedAt);
  expect((await getSettings()).deviceToken).toBe(replacement.deviceToken);
});
