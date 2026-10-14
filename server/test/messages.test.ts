import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChatMessage, RegisterResponse } from '../../shared/api.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

describe('messages', () => {
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer();
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const send = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: '/api/messages', headers: bearer(token), payload });
  const list = (token: string, query = '') =>
    server.app.inject({ method: 'GET', url: `/api/messages${query}`, headers: bearer(token) });

  it('stores a text message', async () => {
    const res = await send(carter.deviceToken, { clientId: 'c-1', kind: 'text', text: 'おはよう' });
    assert.equal(res.statusCode, 201);
    const message = res.json<ChatMessage>();
    assert.equal(message.memberId, carter.memberId);
    assert.equal(message.clientId, 'c-1');
    assert.equal(message.kind, 'text');
    assert.equal(message.text, 'おはよう');
    assert.ok(Number.isInteger(message.id));
    assert.ok(!Number.isNaN(Date.parse(message.createdAt)));
    assert.equal('audioId' in message, false);
  });

  it('is idempotent by clientId per member', async () => {
    const first = await send(carter.deviceToken, { clientId: 'c-2', kind: 'text', text: '元気？' });
    const retry = await send(carter.deviceToken, { clientId: 'c-2', kind: 'text', text: '元気？' });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), first.json());

    // Another member using the same clientId gets their own message.
    const other = await send(aiko.deviceToken, { clientId: 'c-2', kind: 'text', text: '元気！' });
    assert.equal(other.statusCode, 201);
    assert.notEqual(other.json<ChatMessage>().id, first.json<ChatMessage>().id);

    const all = (await list(carter.deviceToken)).json<ChatMessage[]>();
    assert.equal(all.filter((m) => m.clientId === 'c-2' && m.memberId === carter.memberId).length, 1);
  });

  it('stores one message when retries arrive at the same time', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(carter.deviceToken, { clientId: 'burst', kind: 'text', text: 'ただいま' })),
    );
    assert.deepEqual(
      results.map((r) => r.statusCode).sort(),
      [200, 200, 200, 200, 200, 200, 200, 200, 200, 201],
    );
    const ids = new Set(results.map((r) => r.json<ChatMessage>().id));
    assert.equal(ids.size, 1);
  });

  it('validates messages', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ clientId: 'v-1', kind: 'text', text: '   ' }, 'text_required'],
      [{ clientId: 'v-2', kind: 'text', text: 'x'.repeat(2001) }, 'invalid_request'],
      [{ clientId: 'v-3', kind: 'system', text: 'hi' }, 'invalid_request'],
      [{ clientId: '', kind: 'text', text: 'hi' }, 'invalid_request'],
      [{ clientId: 'v-4', kind: 'voice', text: '' }, 'audio_required'],
      [{ clientId: 'v-5', kind: 'voice', text: '', audioId: 'not-a-uuid' }, 'invalid_request'],
      [{ clientId: 'v-6', kind: 'voice', text: '', audioId: crypto.randomUUID() }, 'unknown_audio'],
    ];
    for (const [payload, error] of cases) {
      const res = await send(carter.deviceToken, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error, error);
    }
  });

  it('rejects malformed JSON with a JSON error', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { ...bearer(carter.deviceToken), 'content-type': 'application/json' },
      payload: '{"clientId":',
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'bad_request' });
  });

  it('rejects oversized bodies', async () => {
    const res = await send(carter.deviceToken, { clientId: 'big', kind: 'text', text: 'x'.repeat(300 * 1024) });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: 'too_large' });
  });

  it('lists oldest first with after and limit', async () => {
    for (let i = 0; i < 5; i++) {
      await send(aiko.deviceToken, { clientId: `page-${i}`, kind: 'text', text: `${i}` });
    }
    const all = (await list(aiko.deviceToken)).json<ChatMessage[]>();
    const ids = all.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

    const after = ids[1];
    const page = (await list(aiko.deviceToken, `?after=${after}&limit=2`)).json<ChatMessage[]>();
    assert.deepEqual(
      page.map((m) => m.id),
      ids.filter((id) => id > after).slice(0, 2),
    );

    const none = (await list(aiko.deviceToken, `?after=${ids.at(-1)}`)).json<ChatMessage[]>();
    assert.deepEqual(none, []);
  });

  it('validates list parameters', async () => {
    for (const query of ['?limit=0', '?limit=501', '?after=-1', '?after=abc']) {
      const res = await list(carter.deviceToken, query);
      assert.equal(res.statusCode, 400, query);
    }
  });
});
