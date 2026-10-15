// TECH-DESIGN §5.2 integration test 6: a phone still on the v1 database upgrades to v2 and its chat
// carries on: the cached conversation stays, the catch-up sync continues after it, and the messages
// written before the upgrade are delivered. The real home server runs in process.

import Dexie from 'dexie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, RegisterResponse } from '../../shared/api.ts';
import { db, PROGRESS_TABLES } from '../lib/db.ts';
import { syncMessages } from './chat.ts';
import { flushOutbox } from './outbox.ts';
import { startLiveServer, type LiveServer } from './test-server.ts';

/** The v1 schema as shipped (db.ts keeps it private). */
const V1_STORES = {
  items: 'id, kind, introducedAt',
  cards: 'id, itemId, kind, type, due, state, suspended',
  reviewLogs: '++id, cardId, itemId, reviewedAt',
  days: 'date',
  settings: 'id',
  outbox: 'clientId, createdAt',
  messages: 'id, clientId, createdAt',
  savedSentences: 'id, savedAt',
};

let server: LiveServer;
let me: RegisterResponse;
let partner: RegisterResponse;

beforeAll(async () => {
  server = await startLiveServer();
  me = await server.register('Emma');
  partner = await server.register('Ken');
}, 20_000);

afterAll(async () => {
  db.close();
  await server?.close();
});

async function partnerSays(text: string, n: number): Promise<void> {
  const res = await server.inject('POST', '/api/messages', partner.deviceToken, { clientId: `ken-${n}`, kind: 'text', text });
  expect(res.statusCode).toBeLessThan(300);
}

const serverMessages = async () => (await server.inject('GET', '/api/messages?after=0&limit=100', me.deviceToken)).json<ChatMessage[]>();

describe('Dexie v1 → v2 upgrade with chat continuity (§5.2 test 6)', () => {
  it('keeps the cached chat, catches up after it and delivers the outbox', async () => {
    // The chat as the v1 phone last saw it: three messages, then two written offline.
    for (const [n, text] of ['おはよう', 'げんき？', 'きょうは　さむいね'].entries()) await partnerSays(text, n);
    const seen = await serverMessages();
    expect(seen).toHaveLength(3);

    const t = new Date('2026-09-01T09:00:00Z');
    const v1 = new Dexie('issho');
    v1.version(1).stores(V1_STORES);
    await v1.open();
    await v1.table('settings').put({
      id: 'me', name: 'Emma', onboarded: true, newPerDay: 5, romaji: true, maxReviewsPerDay: 120, desiredRetention: 0.9,
      knowsHiragana: true, knowsKatakana: true, furigana: 'always', audio: true, writingHand: 'finger',
      serverUrl: server.url, deviceToken: me.deviceToken, memberId: me.memberId, householdName: me.householdName,
      lastPairing: { householdId: me.householdId, memberId: me.memberId, serverUrl: server.url },
    });
    await v1.table('messages').bulkAdd(seen.map((m) => ({ id: m.id, clientId: m.clientId, memberId: m.memberId, createdAt: m.createdAt, kind: m.kind, text: m.text })));
    await v1.table('outbox').bulkAdd([
      { clientId: 'emma-1', createdAt: t, kind: 'text', text: 'うん、げんき！', attempts: 0 },
      { clientId: 'emma-2', createdAt: new Date(t.getTime() + 1000), kind: 'text', text: 'さむいね', attempts: 1 },
    ]);
    await v1.table('items').add({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: t });
    v1.close();

    // Meanwhile the partner wrote two more.
    await partnerSays('ばんごはん、なにがいい？', 3);
    await partnerSays('カレーは？', 4);

    // The app opens the database: upgrade to v2. Progress goes, the pairing, chat and outbox stay.
    await db.open();
    expect(db.verno).toBe(2);
    for (const name of PROGRESS_TABLES) expect(await db.table(name).count(), name).toBe(0);
    expect(await db.settings.get('me')).toMatchObject({ deviceToken: me.deviceToken, memberId: me.memberId, onboarded: false });
    expect((await db.messages.toArray()).map((m) => m.text)).toEqual(['おはよう', 'げんき？', 'きょうは　さむいね']);
    expect(await db.outbox.count()).toBe(2);

    // The catch-up sync continues after the newest cached message.
    expect(await syncMessages()).toBe(2);
    expect((await db.messages.orderBy('id').toArray()).map((m) => m.text)).toEqual([
      'おはよう', 'げんき？', 'きょうは　さむいね', 'ばんごはん、なにがいい？', 'カレーは？',
    ]);

    // The outbox flushes in order and each message is stored once.
    expect(await flushOutbox()).toMatchObject({ sent: 2, remaining: 0, blocked: false });
    expect(await db.outbox.count()).toBe(0);
    const delivered = (await serverMessages()).filter((m) => m.memberId === me.memberId);
    expect(delivered.map((m) => [m.clientId, m.text])).toEqual([['emma-1', 'うん、げんき！'], ['emma-2', 'さむいね']]);
    await syncMessages();
    const local = await db.messages.orderBy('id').toArray();
    expect(local).toHaveLength(7);
    expect(new Set(local.map((m) => m.clientId)).size).toBe(7);
  });
});
