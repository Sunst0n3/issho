import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bearer, createTestServer } from './helpers.ts';

const backup = (memberId: string, name = 'Carter') => ({
  format: 'issho-backup', version: 2, exportedAt: new Date().toISOString(),
  tables: { settings: [{ id: 'me', name, memberId }], items: [], cards: [], reviewLogs: [], days: [] },
});

describe('private progress snapshots', () => {
  it('requires authentication and keeps snapshots private to their member', async () => {
    const server = await createTestServer();
    try {
      const me = await server.register('Carter');
      const partner = await server.register('Partner');
      assert.equal((await server.app.inject({ method: 'GET', url: '/api/backups' })).statusCode, 401);
      const saved = await server.app.inject({ method: 'POST', url: '/api/backups', headers: bearer(me.deviceToken), payload: backup(me.memberId) });
      assert.equal(saved.statusCode, 201);
      const snapshot = saved.json<{ id: string; createdAt: string; bytes: number }>();
      assert.ok(snapshot.bytes > 0);
      const own = await server.app.inject({ method: 'GET', url: '/api/backups', headers: bearer(me.deviceToken) });
      assert.equal(own.json<unknown[]>().length, 1);
      const restored = await server.app.inject({ method: 'GET', url: `/api/backups/${snapshot.id}`, headers: bearer(me.deviceToken) });
      assert.equal(restored.json().tables.settings[0].name, 'Carter');
      const other = await server.app.inject({ method: 'GET', url: '/api/backups', headers: bearer(partner.deviceToken) });
      assert.deepEqual(other.json(), []);
      assert.equal((await server.app.inject({ method: 'GET', url: `/api/backups/${snapshot.id}`, headers: bearer(partner.deviceToken) })).statusCode, 404);
    } finally { await server.close(); }
  });

  it('rejects malformed or wrong-person snapshots and credentials', async () => {
    const server = await createTestServer();
    try {
      const me = await server.register('Carter');
      const send = (payload: unknown) => server.app.inject({ method: 'POST', url: '/api/backups', headers: bearer(me.deviceToken), payload: payload as object });
      assert.equal((await send({ bad: true })).statusCode, 400);
      assert.equal((await send(backup('someone-else'))).statusCode, 400);
      const secret = backup(me.memberId);
      Object.assign(secret.tables.settings[0], { deviceToken: 'must-not-be-stored' });
      assert.equal((await send(secret)).statusCode, 400);
    } finally { await server.close(); }
  });

  it('accepts full progress larger than the ordinary API limit and retains fourteen versions', async () => {
    let time = Date.parse('2026-10-16T01:00:00Z');
    const server = await createTestServer({ now: () => new Date(time++) });
    try {
      const me = await server.register('Carter');
      const payload = backup(me.memberId);
      Object.assign(payload.tables, { savedSentences: [{ text: 'x'.repeat(300_000) }] });
      let first = '';
      for (let i = 0; i < 16; i++) {
        const res = await server.app.inject({ method: 'POST', url: '/api/backups', headers: bearer(me.deviceToken), payload });
        assert.equal(res.statusCode, 201);
        first ||= res.json<{ id: string }>().id;
      }
      const list = await server.app.inject({ method: 'GET', url: '/api/backups', headers: bearer(me.deviceToken) });
      assert.equal(list.json<unknown[]>().length, 14);
      assert.equal((await server.app.inject({ method: 'GET', url: `/api/backups/${first}`, headers: bearer(me.deviceToken) })).statusCode, 404);
    } finally { await server.close(); }
  });
});
