import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { backupFileName, BackupError, exportBackup, importBackup } from './backup.ts';
import { db, getSettings, updateSettings } from './db.ts';
import type { CardRecord, OutboxRecord } from './types.ts';

const introduced = new Date('2026-10-01T09:00:00Z');
const due = new Date('2026-10-20T09:00:00Z');

async function seed() {
  const card: CardRecord = { ...createEmptyCard(introduced), due, id: 'kanji:水|meaning', itemId: 'kanji:水', kind: 'kanji', type: 'meaning' };
  await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: introduced, customMnemonic: 'water drips' });
  await db.cards.put(card);
  await db.reviewLogs.add({ cardId: card.id, itemId: 'kanji:水', grade: 3, reviewedAt: introduced, durationMs: 4000, mode: 'choice', prevState: 0 });
  await db.days.put({ date: '2026-10-01', studyMs: 600_000, reviews: 10, correct: 9, newItems: 3, sessionComplete: true });
  await db.savedSentences.put({ id: 's-0001', jp: '{水|みず}', en: 'water', savedAt: introduced });
  await db.messages.put({ id: 1, clientId: 'c1', memberId: 'm1', createdAt: '2026-10-01T09:00:00Z', kind: 'text', text: 'hi' });
  const voice = new NodeBlob(['x'], { type: 'audio/mp4' }) as unknown as Blob;
  await db.outbox.bulkPut([
    { clientId: 'o-text', createdAt: introduced, kind: 'text', text: 'later', attempts: 0 },
    { clientId: 'o-voice', createdAt: introduced, kind: 'voice', text: '', audio: voice, attempts: 0 },
  ] satisfies OutboxRecord[]);
  await updateSettings({ name: 'Carter', onboarded: true, newPerDay: 7, serverUrl: 'http://home:8787', deviceToken: 'secret-token', memberId: 'm1', householdName: 'Home' });
}

const asFile = (value: unknown) => new Blob([typeof value === 'string' ? value : JSON.stringify(value)], { type: 'application/json' });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('exportBackup', () => {
  it('writes every table, tags dates, and leaves out the device token and voice audio', async () => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());

    expect(parsed).toMatchObject({ format: 'issho-backup', version: 1 });
    expect(Object.keys(parsed.tables).sort()).toEqual(db.tables.map((t) => t.name).sort());
    expect(parsed.tables.items[0].introducedAt).toEqual({ $date: introduced.toISOString() });
    expect(parsed.tables.cards[0].due).toEqual({ $date: due.toISOString() });
    expect(parsed.tables.settings[0]).not.toHaveProperty('deviceToken');
    expect(parsed.tables.settings[0]).toMatchObject({ name: 'Carter', memberId: 'm1' });
    expect(parsed.tables.outbox.map((r: { clientId: string }) => r.clientId)).toEqual(['o-text']);
  });

  it('names files by date', () => {
    expect(backupFileName(new Date(2026, 0, 5))).toBe('issho-backup-2026-01-05.json');
  });
});

describe('importBackup', () => {
  it('validates without changing anything, then restores on apply()', async () => {
    await seed();
    const file = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    await updateSettings({ name: 'Someone', serverUrl: 'http://new:8787', deviceToken: 'this-device', memberId: 'm1', householdName: 'Home' });

    const plan = await importBackup(file);
    expect(plan.counts).toMatchObject({ items: 1, cards: 1, reviewLogs: 1, days: 1, settings: 1, outbox: 1, messages: 1, savedSentences: 1 });
    expect(plan.exportedAt).toBeInstanceOf(Date);
    expect(await db.items.count()).toBe(0);

    await plan.apply();

    const item = await db.items.get('kanji:水');
    expect(item?.introducedAt).toBeInstanceOf(Date);
    expect(item?.introducedAt.getTime()).toBe(introduced.getTime());
    expect(item?.customMnemonic).toBe('water drips');
    const card = await db.cards.get('kanji:水|meaning');
    expect(card?.due).toBeInstanceOf(Date);
    expect(card?.due.getTime()).toBe(due.getTime());
    expect(await db.reviewLogs.count()).toBe(1);
    expect((await db.savedSentences.get('s-0001'))?.savedAt).toBeInstanceOf(Date);

    // Progress and preferences come from the backup; the pairing stays this device's own.
    const s = await getSettings();
    expect(s).toMatchObject({ name: 'Carter', newPerDay: 7, onboarded: true, deviceToken: 'this-device', serverUrl: 'http://new:8787' });
  });

  it('replaces existing progress rather than merging', async () => {
    await seed();
    const file = await exportBackup();
    await db.items.put({ id: 'kanji:火', kind: 'kanji', key: '火', introducedAt: new Date() });
    await (await importBackup(file)).apply();
    expect((await db.items.toArray()).map((i) => i.id)).toEqual(['kanji:水']);
  });

  it("keeps which household this phone's chat and outbox belong to", async () => {
    await seed();
    await updateSettings({ lastPairing: { householdId: 'h-old', memberId: 'm1', serverUrl: 'http://home:8787' } });
    const file = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    const mine = { householdId: 'h-new', memberId: 'm9', serverUrl: 'http://new:8787' };
    await updateSettings({ serverUrl: 'http://new:8787', deviceToken: 'this-device', memberId: 'm9', lastPairing: mine });
    await (await importBackup(file)).apply();
    expect((await getSettings()).lastPairing).toEqual(mine);

    // An unpaired phone keeps its own last pairing too (or none).
    await updateSettings({ deviceToken: undefined, memberId: undefined, lastPairing: undefined });
    await (await importBackup(file)).apply();
    expect((await getSettings()).lastPairing).toBeUndefined();
  });

  it('leaves an unpaired device unpaired', async () => {
    await seed();
    const file = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    await (await importBackup(file)).apply();
    const s = await getSettings();
    expect(s.deviceToken).toBeUndefined();
    expect(s.memberId).toBeUndefined();
  });

  it("keeps this device's chat when the backup comes from another pairing", async () => {
    await seed(); // member m1 on http://home:8787, with message 1 and an unsent text
    const file = await exportBackup();
    await Promise.all(db.tables.map((t) => t.clear()));
    // Since then the server was reset and this phone re-paired: new member, new message ids.
    await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'new-token', memberId: 'm9', householdName: 'Home' });
    await db.messages.put({ id: 1, clientId: 'fresh', memberId: 'm9', createdAt: '2026-10-14T09:00:00Z', kind: 'text', text: 'new server' });
    await db.outbox.put({ clientId: 'mine', createdAt: due, kind: 'text', text: 'not sent yet', attempts: 0 });

    const plan = await importBackup(file);
    expect(plan.counts).toMatchObject({ items: 1, messages: 0, outbox: 0 });
    await plan.apply();

    // Old-household rows would show up in the wrong chat (and old ids would derail the
    // catch-up cursor); the old unsent text must not be posted to the new household.
    expect((await db.messages.toArray()).map((m) => m.clientId)).toEqual(['fresh']);
    expect((await db.outbox.toArray()).map((r) => r.clientId)).toEqual(['mine']);
    expect(await db.items.count()).toBe(1);
  });

  it('merges chat from a backup made by this same member on this server', async () => {
    await seed();
    const file = await exportBackup();
    await db.messages.clear();
    await db.messages.put({ id: 2, clientId: 'c2', memberId: 'm2', createdAt: '2026-10-02T09:00:00Z', kind: 'text', text: 'newer' });

    await (await importBackup(file)).apply();

    expect((await db.messages.orderBy('id').toArray()).map((m) => m.clientId)).toEqual(['c1', 'c2']);
    expect((await db.outbox.toArray()).map((r) => r.clientId).sort()).toEqual(['o-text', 'o-voice']);
  });

  it("keeps this device's settings and pairing when the backup has none", async () => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());
    parsed.tables.settings = [];
    await (await importBackup(asFile(parsed))).apply();
    expect(await getSettings()).toMatchObject({ name: 'Carter', onboarded: true, deviceToken: 'secret-token', memberId: 'm1' });
  });

  it.each([
    ['cards', 'stability', 'high'],
    ['cards', 'state', null],
    ['days', 'reviews', '10'],
    ['items', 'kind', 'spell'],
  ])('rejects %s rows with a damaged %s', async (table, field, value) => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());
    parsed.tables[table][0][field] = value;
    await expect(importBackup(asFile(parsed))).rejects.toThrow(new RegExp(`row 1 of ${table}`));
  });

  it.each([
    ['not JSON', 'hello', /not valid JSON/],
    ['another app', { format: 'other', version: 1, tables: {} }, /not an Issho backup/],
    ['a newer version', { format: 'issho-backup', version: 99, exportedAt: '2026-10-14T00:00:00Z', tables: {} }, /newer version/],
    ['missing tables', { format: 'issho-backup', version: 1, exportedAt: '2026-10-14T00:00:00Z', tables: {} }, /missing/],
  ])('rejects %s', async (_name, content, message) => {
    const err = await importBackup(asFile(content)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).toMatch(message);
  });

  it('rejects damaged rows', async () => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());
    parsed.tables.cards[0].due = 'yesterday';
    await expect(importBackup(asFile(parsed))).rejects.toThrow(/row 1 of cards/);
  });

  it('does not let a "__proto__" key stand in for a missing field', async () => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());
    const text = JSON.stringify(parsed).replace('"settings":[{"id":"me",', '"settings":[{"__proto__":{"id":"me"},');
    expect(text).toContain('__proto__');
    await expect(importBackup(asFile(text))).rejects.toThrow(/row 1 of settings/);
  });

  it('rejects an invalid tagged date', async () => {
    await seed();
    const parsed = JSON.parse(await (await exportBackup()).text());
    parsed.tables.items[0].introducedAt = { $date: 'not a date' };
    await expect(importBackup(asFile(parsed))).rejects.toThrow(BackupError);
  });
});
