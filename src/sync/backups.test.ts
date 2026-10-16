import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import { createEmptyCard } from 'ts-fsrs';
import { importBackup } from '../lib/backup.ts';
import { flushServerBackup, requestServerBackup } from './backups.ts';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ name: 'Carter', onboarded: true, deviceToken: 'secret', memberId: 'me', serverUrl: 'http://home:8787' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('automatic progress snapshots', () => {
  it('keeps a newer sitting pending when it is requested during an upload at the same clock time', async () => {
    const now = new Date('2026-10-16T02:00:00Z');
    let finish!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = () => resolve(new Response(JSON.stringify({ id: 'first', createdAt: now.toISOString(), bytes: 500 })));
    }));
    const first = requestServerBackup(now);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = requestServerBackup(now);
    try {
      await vi.waitFor(async () => expect((await getSettings()).serverBackupRequestedAt).not.toBe(now.toISOString()));
    } finally {
      finish();
      await Promise.all([first, second]);
    }
    expect((await getSettings()).serverBackupPending).toBe(true);
  });
  it('keeps a failed upload pending and retries a token-free, restorable snapshot', async () => {
    const now = new Date('2026-10-16T02:00:00Z');
    await db.items.put({ id: 'kanji:水', key: '水', kind: 'kanji', introducedAt: now });
    await db.cards.put({ ...createEmptyCard(now), id: 'kanji:水|write', itemId: 'kanji:水', kind: 'kanji', type: 'write' });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await requestServerBackup(now);
    expect((await getSettings()).serverBackupPending).toBe(true);
    let uploaded: unknown;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      uploaded = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'saved', createdAt: now.toISOString(), bytes: 500 }));
    });
    await flushServerBackup();
    expect(JSON.stringify(uploaded)).not.toContain('secret');
    expect((await getSettings()).serverBackupPending).toBe(false);
    expect((await getSettings()).serverBackupCompletedAt).toBe(now.toISOString());
    await db.items.clear(); await db.cards.clear();
    const restore = await importBackup(new Blob([JSON.stringify(uploaded)]));
    await restore.apply();
    expect(await db.cards.get('kanji:水|write')).toBeDefined();
    expect((await getSettings()).deviceToken).toBe('secret');
  });

  it('does not send another learner’s pending snapshot after re-pairing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await requestServerBackup();
    await updateSettings({ memberId: 'partner', deviceToken: 'partner-token' });
    fetchMock.mockClear();
    await flushServerBackup();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
