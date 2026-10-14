import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ClientEvent, RegisterResponse, ServerEvent } from '../../shared/api.ts';
import { WS_CLOSE_UNPAIRED } from '../src/hub.ts';
import { bearer, createTestServer, listen, openSocket, tick, type TestServer } from './helpers.ts';

describe('websocket', () => {
  let server: TestServer;
  let base: string;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer();
    base = await listen(server);
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const isPresence = (memberId: string, online: boolean) => (e: ServerEvent) =>
    e.type === 'presence' && e.memberId === memberId && e.online === online;

  it('rejects a bad token before upgrading', async () => {
    await assert.rejects(openSocket(base, 'A'.repeat(43)));
  });

  it('tracks presence across connections', async () => {
    const a = await openSocket(base, carter.deviceToken);
    const b = await openSocket(base, aiko.deviceToken);

    await a.events.next(isPresence(aiko.memberId, true));
    // The newcomer learns who is already online.
    await b.events.next(isPresence(carter.memberId, true));

    // A second device for Aiko is not a new "online" event, and closing one of two isn't "offline".
    const b2 = await openSocket(base, aiko.deviceToken);
    await b.close();
    await tick(50);
    assert.equal(a.events.all.filter((e) => e.type === 'presence' && e.memberId === aiko.memberId).length, 1);

    await b2.close();
    await a.events.next(isPresence(aiko.memberId, false));
    assert.ok(server.store.getMember(aiko.memberId)?.lastSeenAt);
    await a.close();
  });

  it('pushes messages, stats and quizzes', async () => {
    const a = await openSocket(base, carter.deviceToken);
    const b = await openSocket(base, aiko.deviceToken);

    const sent = await server.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: bearer(aiko.deviceToken),
      payload: { clientId: 'ws-1', kind: 'text', text: 'ただいま' },
    });
    for (const client of [a, b]) {
      const event = await client.events.next((e) => e.type === 'message');
      assert.deepEqual(event, { type: 'message', message: sent.json() });
    }

    await server.app.inject({
      method: 'POST',
      url: '/api/stats',
      headers: bearer(aiko.deviceToken),
      payload: { days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1 },
    });
    assert.deepEqual(await a.events.next((e) => e.type === 'stats'), { type: 'stats', memberId: aiko.memberId });

    const quiz = await server.app.inject({
      method: 'POST',
      url: '/api/quizzes',
      headers: bearer(carter.deviceToken),
      payload: { toMemberId: aiko.memberId, items: [{ char: '水' }] },
    });
    assert.deepEqual(await b.events.next((e) => e.type === 'quiz'), { type: 'quiz', quiz: quiz.json() });

    await Promise.all([a.close(), b.close()]);
  });

  it('relays role-play state to the other members only', async () => {
    const a = await openSocket(base, carter.deviceToken);
    const a2 = await openSocket(base, carter.deviceToken);
    const b = await openSocket(base, aiko.deviceToken);

    a.send('not json');
    a.send({ type: 'roleplay', state: { sessionId: 's' } });
    a.send({ type: 'ping' } satisfies ClientEvent);
    const state = { sessionId: 's-1', scriptId: 'cafe', role: 'a', lineIndex: 2, status: 'active' } as const;
    a.send({ type: 'roleplay', state } satisfies ClientEvent);

    const relayed = await b.events.next((e) => e.type === 'roleplay');
    assert.deepEqual(relayed, { type: 'roleplay', memberId: carter.memberId, state });
    await tick(50);
    assert.equal(b.events.all.filter((e) => e.type === 'roleplay').length, 1);
    assert.equal(a2.events.all.some((e) => e.type === 'roleplay'), false);
    assert.equal(a.events.all.some((e) => e.type === 'roleplay'), false);
    // Malformed frames are ignored without dropping the connection.
    assert.equal(a.ws.readyState, WebSocket.OPEN);

    await Promise.all([a.close(), a2.close(), b.close()]);
  });

  it('disconnects devices signed out with the admin CLI', async () => {
    const own = await createTestServer({ heartbeatMs: 20 });
    try {
      const ownBase = await listen(own);
      const a = await own.register('Carter');
      const b = await own.register('Aiko');
      const kept = await openSocket(ownBase, a.deviceToken);
      const revoked = await openSocket(ownBase, b.deviceToken);
      const code = new Promise<number>((resolve) =>
        revoked.ws.addEventListener('close', (e) => resolve(e.code), { once: true }),
      );

      // What `admin revoke` does, from another process.
      own.store.revokeDevices(b.memberId);
      assert.equal(await code, WS_CLOSE_UNPAIRED);
      await kept.events.next(isPresence(b.memberId, false));
      await tick(60);
      assert.equal(kept.ws.readyState, WebSocket.OPEN);
      await kept.close();
    } finally {
      await own.close();
    }
  });

  it('closes sockets with 1001 when the server shuts down', async () => {
    const own = await createTestServer();
    const ownBase = await listen(own);
    const { deviceToken } = await own.register('Carter');
    const socket = await openSocket(ownBase, deviceToken);
    const code = new Promise<number>((resolve) =>
      socket.ws.addEventListener('close', (e) => resolve(e.code), { once: true }),
    );
    const started = Date.now();
    await own.close();
    assert.equal(await code, 1001);
    assert.ok(Date.now() - started < 1500, 'shutdown should not wait for the grace timeout');
  });
});

describe('websocket upgrades on other paths', () => {
  it('are refused, and the device token never reaches the log', { timeout: 5000 }, async () => {
    // With a built app, every GET path has a route (the static files and SPA fallback).
    const outside = await mkdtemp(path.join(tmpdir(), 'issho-ws-'));
    const dist = path.join(outside, 'dist');
    await mkdir(dist);
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Issho</title>');
    const logLines: string[] = [];
    const server = await createTestServer({ staticDir: dist, logLines });
    try {
      const base = await listen(server);
      const { deviceToken } = await server.register('Carter');

      for (const wrongPath of ['/', '/together', '/api/ws/', '/api/health', '/api/nope']) {
        await assert.rejects(openSocket(base, deviceToken, wrongPath), wrongPath);
      }
      const socket = await openSocket(base, deviceToken);
      await socket.close();

      assert.ok(logLines.some((line) => line.includes('/api/ws?token=[redacted]')));
      assert.equal(logLines.filter((line) => line.includes(deviceToken)).length, 0);
    } finally {
      // Refused sockets must be destroyed, or this close never finishes.
      await server.close();
      await rm(outside, { recursive: true, force: true });
    }
  });
});
