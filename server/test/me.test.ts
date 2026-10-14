import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { HouseholdResponse, Member, RegisterResponse } from '../../shared/api.ts';
import { WS_CLOSE_UNPAIRED } from '../src/hub.ts';
import { bearer, createTestServer, HOUSEHOLD_CODE, listen, openSocket, type TestServer } from './helpers.ts';

describe('your own member and device', () => {
  let server: TestServer;
  let carter: RegisterResponse;
  let mika: RegisterResponse;

  beforeEach(async () => {
    server = await createTestServer();
    carter = await server.register('Carter');
    mika = await server.register('Mika');
  });
  afterEach(() => server.close());

  const rename = (token: string, payload: unknown) =>
    server.app.inject({ method: 'PATCH', url: '/api/me', headers: bearer(token), payload: payload as object });
  const names = async (token: string) => {
    const res = await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(token) });
    return res.json<HouseholdResponse>().members.map((m) => m.member.name);
  };
  const register = async (payload: Record<string, unknown>) => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { householdCode: HOUSEHOLD_CODE, ...payload },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json<RegisterResponse>();
  };

  it('renames the caller, which the partner sees', async () => {
    const res = await rename(carter.deviceToken, { name: '  Carter C ' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      { id: res.json<Member>().id, name: res.json<Member>().name },
      { id: carter.memberId, name: 'Carter C' },
    );
    assert.deepEqual(await names(mika.deviceToken), ['Carter C', 'Mika']);

    // Pairing again under the new name finds the same member: no ghost.
    const again = await server.register('Carter C');
    assert.equal(again.memberId, carter.memberId);
    assert.deepEqual(await names(mika.deviceToken), ['Carter C', 'Mika']);
  });

  it("refuses another member's name and bad names", async () => {
    const taken = await rename(carter.deviceToken, { name: 'mika' });
    assert.equal(taken.statusCode, 409);
    assert.deepEqual(taken.json(), { error: 'name_taken' });
    for (const name of ['', '   ', 'x'.repeat(41), 'a\u0000b', 42]) {
      assert.equal((await rename(carter.deviceToken, { name })).statusCode, 400, JSON.stringify(name));
    }
    // A change of case only is your own name.
    assert.equal((await rename(carter.deviceToken, { name: 'CARTER' })).statusCode, 200);
    assert.deepEqual(await names(mika.deviceToken), ['CARTER', 'Mika']);
  });

  it('tells the other phones to refresh after a rename', async () => {
    const base = await listen(server);
    const socket = await openSocket(base, mika.deviceToken);
    await rename(carter.deviceToken, { name: 'Carter C' });
    assert.deepEqual(await socket.events.next((e) => e.type === 'stats'), { type: 'stats', memberId: carter.memberId });
    await socket.close();
  });

  it('pairing again as the member this phone was keeps that member, renamed', async () => {
    // The name changed while the phone was disconnected (so the rename never reached the server).
    const again = await register({ name: 'Carter C', memberId: carter.memberId });
    assert.equal(again.memberId, carter.memberId);
    assert.deepEqual(await names(mika.deviceToken), ['Carter C', 'Mika']);

    // The name of another member wins over the old member id (the phone was handed on).
    const handedOn = await register({ name: 'Mika', memberId: carter.memberId });
    assert.equal(handedOn.memberId, mika.memberId);
    // An unknown member id (another server's, or a removed member) is ignored.
    const unknown = await register({ name: 'Aiko', memberId: crypto.randomUUID() });
    assert.notEqual(unknown.memberId, carter.memberId);
    assert.deepEqual(await names(mika.deviceToken), ['Carter C', 'Mika', 'Aiko']);
  });

  it('gives every pairing the same household id', async () => {
    assert.match(carter.householdId, /^[0-9a-f-]{36}$/);
    assert.equal(mika.householdId, carter.householdId);
    assert.equal((await server.register('Carter')).householdId, carter.householdId);
  });

  it('signs a device out: its token stops working and its socket closes at once', async () => {
    const base = await listen(server);
    const tablet = await server.register('Carter');
    const phoneSocket = await openSocket(base, carter.deviceToken);
    const tabletSocket = await openSocket(base, tablet.deviceToken);

    const res = await server.app.inject({ method: 'POST', url: '/api/signout', headers: bearer(carter.deviceToken) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(await phoneSocket.closed, WS_CLOSE_UNPAIRED);

    const after = await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(carter.deviceToken) });
    assert.equal(after.statusCode, 401);
    // The member's other device stays signed in.
    assert.equal(server.store.deviceCount(carter.memberId), 1);
    assert.equal(tabletSocket.ws.readyState, WebSocket.OPEN);
    await tabletSocket.close();
  });
});
