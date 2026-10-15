import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HealthResponse } from '../../shared/api.ts';
import { bearerToken, hashToken, safeEqual } from '../src/auth.ts';
import { WS_CLOSE_UNPAIRED } from '../src/hub.ts';
import { bearer, createTestServer, HOUSEHOLD_CODE, type TestServer } from './helpers.ts';

describe('auth helpers', () => {
  it('compares secrets of any length without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('short', 'a much longer secret'), false);
    assert.equal(safeEqual('', ''), true);
  });

  it('parses bearer headers', () => {
    assert.equal(bearerToken('Bearer abc'), 'abc');
    assert.equal(bearerToken('bearer   abc '), 'abc');
    assert.equal(bearerToken('Basic abc'), null);
    assert.equal(bearerToken(undefined), null);
  });
});

describe('health and registration', () => {
  let server: TestServer;
  before(async () => {
    server = await createTestServer();
  });
  after(() => server.close());

  it('reports health without auth', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json<HealthResponse>();
    assert.equal(body.ok, true);
    assert.equal(body.aiEnabled, false);
    assert.equal(body.ttsEnabled, false);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('reports TTS from the service’s last check', async () => {
    let available = true;
    const tts = {
      available: () => available,
      synthesize: async () => ({ wav: Buffer.alloc(0), cached: false }),
      close: () => {},
    };
    const own = await createTestServer({ tts });
    try {
      const health = async () => (await own.app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
      assert.equal((await health()).ttsEnabled, true);
      available = false;
      assert.equal((await health()).ttsEnabled, false);
    } finally {
      await own.close();
    }
  });

  it('rejects a wrong household code', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { householdCode: 'nope', name: 'Carter' },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'invalid_code' });
  });

  it('validates the name', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { householdCode: HOUSEHOLD_CODE, name: '   ' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_request');
  });

  it('registers members and stores only token hashes', async () => {
    const carter = await server.register('Carter');
    assert.match(carter.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(carter.householdName, 'Our home');
    assert.equal(server.store.memberForTokenHash(hashToken(carter.deviceToken))?.id, carter.memberId);
    assert.equal(server.store.memberForTokenHash(carter.deviceToken), undefined);

    // Same name (ignoring case and spacing) is the same member on a new device.
    const secondPhone = await server.register('  carter ');
    assert.equal(secondPhone.memberId, carter.memberId);
    assert.notEqual(secondPhone.deviceToken, carter.deviceToken);

    for (const token of [carter.deviceToken, secondPhone.deviceToken]) {
      const res = await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(token) });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().me, carter.memberId);
    }
  });

  it('trims a household code typed with a trailing space', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { householdCode: `${HOUSEHOLD_CODE} `, name: 'Aiko' },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe('registration with a very long household code', () => {
  it('reports a wrong code of any length as invalid_code, so the form names the right field', async () => {
    const server = await createTestServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { householdCode: 'x'.repeat(5_000), name: 'Carter' },
      });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { error: 'invalid_code' });
    } finally {
      await server.close();
    }
  });
});

describe('registration rate limit', () => {
  it('allows 5 attempts per minute per IP', async () => {
    const server = await createTestServer();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await server.app.inject({
          method: 'POST',
          url: '/api/register',
          payload: { householdCode: 'wrong', name: 'X' },
        });
        assert.equal(res.statusCode, 401);
      }
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { householdCode: HOUSEHOLD_CODE, name: 'X' },
      });
      assert.equal(res.statusCode, 429);
      assert.deepEqual(res.json(), { error: 'rate_limited' });
      assert.ok(Number(res.headers['retry-after']) > 0);
    } finally {
      await server.close();
    }
  });
});

describe('registration rate limit behind a reverse proxy', () => {
  it('limits by the address the proxy saw, not what the client wrote', async () => {
    const server = await createTestServer({ env: { TRUST_PROXY: '127.0.0.1' } });
    try {
      const attempt = (forwardedFor: string, remoteAddress = '127.0.0.1') =>
        server.app.inject({
          method: 'POST',
          url: '/api/register',
          remoteAddress,
          headers: { 'x-forwarded-for': forwardedFor },
          payload: { householdCode: 'wrong', name: 'X' },
        });

      // The proxy appends the real client address after whatever the client sent.
      for (let i = 0; i < 5; i++) assert.equal((await attempt(`10.9.8.${i}, 203.0.113.9`)).statusCode, 401);
      assert.equal((await attempt('10.9.8.99, 203.0.113.9')).statusCode, 429);
      assert.equal((await attempt('198.51.100.1')).statusCode, 401, 'another client has its own budget');

      // A client that bypasses the proxy can't forge the header either.
      for (let i = 0; i < 5; i++) await attempt(`10.0.0.${i}`, '192.0.2.50');
      assert.equal((await attempt('10.0.0.99', '192.0.2.50')).statusCode, 429);
    } finally {
      await server.close();
    }
  });
});

describe('protected routes', () => {
  let server: TestServer;
  before(async () => {
    server = await createTestServer();
  });
  after(() => server.close());

  const routes: [string, string][] = [
    ['GET', '/api/household'],
    ['POST', '/api/stats'],
    ['GET', '/api/messages'],
    ['POST', '/api/messages'],
    ['POST', '/api/voice'],
    ['GET', '/api/voice/6f1c0b8e-6a7d-4d1e-9d55-0c1c7a1f4f00'],
    ['GET', '/api/quizzes'],
    ['POST', '/api/quizzes'],
    ['POST', '/api/quizzes/6f1c0b8e-6a7d-4d1e-9d55-0c1c7a1f4f00/result'],
    ['POST', '/api/ai/check'],
    ['POST', '/api/ai/translate'],
    ['PATCH', '/api/me'],
    ['POST', '/api/signout'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url} needs a device token`, async () => {
      const missing = await server.app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      assert.equal(missing.statusCode, 401);
      assert.deepEqual(missing.json(), { error: 'unauthorized' });

      const wrong = await server.app.inject({
        method: method as 'GET',
        url,
        headers: bearer('A'.repeat(43)),
      });
      assert.equal(wrong.statusCode, 401);
    });
  }

  it('does not accept the token as a query parameter on HTTP routes', async () => {
    const { deviceToken } = await server.register('Carter');
    const res = await server.app.inject({ method: 'GET', url: `/api/household?token=${deviceToken}` });
    assert.equal(res.statusCode, 401);
  });

  it('closes WebSockets without a valid token as unpaired, which a browser can see', async () => {
    // An HTTP 401 instead of the upgrade reaches a browser only as close code 1006, which looks
    // like a network problem: the phone would retry forever instead of offering to pair again.
    for (const url of ['/api/ws', `/api/ws?token=${'A'.repeat(43)}`, '/api/ws?token=short']) {
      let closed!: Promise<number>;
      await server.app.injectWS(url, {}, {
        onInit(socket) {
          closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
        },
      });
      assert.equal(await closed, WS_CLOSE_UNPAIRED, url);
    }
    // A plain GET (no upgrade) is still just unauthorized.
    const plain = await server.app.inject({ method: 'GET', url: `/api/ws?token=${'A'.repeat(43)}` });
    assert.equal(plain.statusCode, 401);
  });

  it('updates lastSeenAt on authenticated requests', async () => {
    const { deviceToken, memberId } = await server.register('Aiko');
    assert.equal(server.store.getMember(memberId)?.lastSeenAt, null);
    await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(deviceToken) });
    assert.ok(server.store.getMember(memberId)?.lastSeenAt);
  });
});
