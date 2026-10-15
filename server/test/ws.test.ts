import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ClientEvent, RegisterResponse, ServerEvent, TogetherLiveState } from '../../shared/api.ts';
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

  it('closes a socket opened with an unknown token as unpaired', async () => {
    // E.g. the server's data was reset: the phone must learn it should pair again.
    const socket = await openSocket(base, 'A'.repeat(43));
    assert.equal(await socket.closed, WS_CLOSE_UNPAIRED);
    assert.equal(socket.events.all.length, 0);
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

  it('relays live together-session state to the other members only', async () => {
    const a = await openSocket(base, carter.deviceToken);
    const a2 = await openSocket(base, carter.deviceToken);
    const b = await openSocket(base, aiko.deviceToken);

    a.send({ type: 'live', state: { sessionId: 's' } });
    const state: TogetherLiveState = {
      sessionId: 'live-1',
      session: 'A',
      opener: carter.memberId,
      plan: { conversation: { scriptId: 'rp-u01', stage: 2 }, storyId: 'st-l0-01' },
      quizIds: { [carter.memberId]: crypto.randomUUID() },
      step: 'quiz',
      turn: aiko.memberId,
      index: 3,
      timerStartedAt: 1_760_000_000_000,
      status: 'active',
    };
    a.send({ type: 'live', state } satisfies ClientEvent);

    const relayed = await b.events.next((e) => e.type === 'live');
    assert.deepEqual(relayed, { type: 'live', memberId: carter.memberId, state });
    await tick(50);
    assert.equal(b.events.all.filter((e) => e.type === 'live').length, 1);
    assert.equal(a2.events.all.some((e) => e.type === 'live'), false);

    // A role-play state may carry its conversation stage.
    const roleplay = { sessionId: 's-2', scriptId: 'rp-u01', role: 'b', lineIndex: 0, status: 'waiting', stage: 3 } as const;
    a.send({ type: 'roleplay', state: roleplay } satisfies ClientEvent);
    assert.deepEqual(await b.events.next((e) => e.type === 'roleplay'), { type: 'roleplay', memberId: carter.memberId, state: roleplay });

    await Promise.all([a.close(), a2.close(), b.close()]);
  });

  it('stops sending household events to a revoked device at once', async () => {
    // Long heartbeat and pairing check: only the check before each delivery can catch it.
    const own = await createTestServer({ heartbeatMs: 60_000, pairingCheckMs: 60_000 });
    try {
      const ownBase = await listen(own);
      const ken = await own.register('Ken');
      const aiko = await own.register('Aiko');
      const revoked = await openSocket(ownBase, ken.deviceToken);
      const kept = await openSocket(ownBase, aiko.deviceToken);
      await kept.events.next(isPresence(ken.memberId, true));

      // `admin revoke Ken`, from another process, then Aiko writes right away.
      own.store.revokeDevices(ken.memberId);
      await own.app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: bearer(aiko.deviceToken),
        payload: { clientId: 'after-revoke', kind: 'text', text: 'もしもし' },
      });
      assert.equal(await revoked.closed, WS_CLOSE_UNPAIRED);
      assert.equal(revoked.events.all.some((e) => e.type === 'message'), false);
      await kept.events.next((e) => e.type === 'message');
      await kept.close();
    } finally {
      await own.close();
    }
  });

  it('closes a revoked device within seconds even when nothing is sent', async () => {
    const own = await createTestServer({ heartbeatMs: 60_000, pairingCheckMs: 20 });
    try {
      const ownBase = await listen(own);
      const ken = await own.register('Ken');
      const socket = await openSocket(ownBase, ken.deviceToken);
      own.store.revokeDevices(ken.memberId);
      assert.equal(await socket.closed, WS_CLOSE_UNPAIRED);
    } finally {
      await own.close();
    }
  });

  it('disconnects devices signed out with the admin CLI', async () => {
    const own = await createTestServer({ heartbeatMs: 20 });
    try {
      const ownBase = await listen(own);
      const a = await own.register('Carter');
      const b = await own.register('Aiko');
      const kept = await openSocket(ownBase, a.deviceToken);
      const revoked = await openSocket(ownBase, b.deviceToken);
      // What `admin revoke` does, from another process.
      own.store.revokeDevices(b.memberId);
      assert.equal(await revoked.closed, WS_CLOSE_UNPAIRED);
      await kept.events.next(isPresence(b.memberId, false));
      await tick(60);
      assert.equal(kept.ws.readyState, WebSocket.OPEN);
      await kept.close();
    } finally {
      await own.close();
    }
  });

  it('accepts sockets from pages on another origin', async () => {
    // The app opened from one address can use the home server at another (Advanced: server address).
    const { WebSocket: NodeWebSocket } = await import('ws');
    const socket = new NodeWebSocket(`${base}/api/ws?token=${encodeURIComponent(carter.deviceToken)}`, {
      headers: { origin: 'http://localhost:5173' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.close();
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
