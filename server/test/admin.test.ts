import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ChatMessage, HouseholdResponse, QuizzesResponse, RegisterResponse } from '../../shared/api.ts';
import { runAdmin } from '../src/admin.ts';
import { dataPaths } from '../src/config.ts';
import { bearer, createTestServer, tick, uploadVoice, type TestServer } from './helpers.ts';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The real command line, as `docker compose exec` runs it. */
function cli(dataDir: string, ...args: string[]) {
  return promisify(execFile)(process.execPath, ['src/admin.ts', ...args], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    timeout: 10_000,
  });
}

describe('admin CLI', () => {
  // The CLI opens the database file while the server holds it open, as it would in production.
  let server: TestServer;
  let carter: RegisterResponse;
  let carterTablet: RegisterResponse;
  let aiko: RegisterResponse;

  async function admin(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdmin(args, {
      env: { DATA_DIR: server.dataDir },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const get = (url: string, token: string) => server.app.inject({ method: 'GET', url, headers: bearer(token) });
  const household = async (token: string) => {
    const res = await get('/api/household', token);
    assert.equal(res.statusCode, 200);
    return res.json<HouseholdResponse>();
  };

  before(async () => {
    server = await createTestServer({ fileStore: true });
    carter = await server.register('Carter');
    carterTablet = await server.register('carter');
    aiko = await server.register('Aiko');
    await household(carter.deviceToken); // sets Carter's last seen
  });
  after(() => server.close());

  it('lists members with their devices and when they were last seen', async () => {
    const { code, out } = await admin('list');
    assert.equal(code, 0);
    assert.match(out, /^Our home: 2 members$/m);
    assert.match(out, /^ID\s+DEVICES\s+LAST SEEN\s+NAME$/m);
    assert.match(out, new RegExp(`^${carter.memberId}  2 +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  Carter$`, 'm'));
    assert.match(out, new RegExp(`^${aiko.memberId}  1 +never +Aiko$`, 'm'));
  });

  it('runs as `node src/admin.ts` without the server’s secrets', async () => {
    const { stdout } = await cli(server.dataDir, 'list');
    assert.match(stdout, /Carter$/m);
    assert.match(stdout, /Aiko$/m);
  });

  it('renames a member', async () => {
    const renamed = await admin('rename', 'CARTER', 'Kaito');
    assert.equal(renamed.code, 0);
    assert.equal(renamed.out, 'Renamed "Carter" to "Kaito"');
    const me = (await household(aiko.deviceToken)).members.find((m) => m.member.id === carter.memberId);
    assert.equal(me?.member.name, 'Kaito');
    // The new name is the one a re-registering phone matches.
    assert.equal(server.store.findMemberByName('kaito')?.id, carter.memberId);

    const taken = await admin('rename', carter.memberId, 'aiko');
    assert.equal(taken.code, 1);
    assert.equal(taken.err, '"Aiko" already has that name.');
    assert.equal((await admin('rename', 'Kaito', '   ')).code, 1);
    assert.equal(server.store.getMember(carter.memberId)?.name, 'Kaito');
  });

  it('shows and changes the household name while the server runs', async () => {
    assert.equal((await admin('household-name')).out, 'Our home');
    const set = await admin('household-name', '  The Caldwell nest ');
    assert.equal(set.code, 0);
    assert.equal(set.out, 'Household name set to "The Caldwell nest"');
    assert.equal((await admin('household-name')).out, 'The Caldwell nest');
    assert.equal((await household(carter.deviceToken)).householdName, 'The Caldwell nest');
    assert.equal((await server.register('Kaito')).householdName, 'The Caldwell nest');
    assert.equal((await admin('household-name', '')).code, 1);
  });

  it('signs out every device of a member', async () => {
    const before = await admin('list');
    assert.match(before.out, new RegExp(`^${carter.memberId}  3 `, 'm'));

    const revoked = await admin('revoke', 'kaito');
    assert.equal(revoked.code, 0);
    assert.match(revoked.out, /^Signed out "Kaito" on 3 devices\./);
    for (const token of [carter.deviceToken, carterTablet.deviceToken]) {
      assert.equal((await get('/api/household', token)).statusCode, 401);
    }
    assert.equal((await get('/api/household', aiko.deviceToken)).statusCode, 200);
    assert.equal((await admin('revoke', 'Kaito')).out, '"Kaito" has no paired devices.');

    // Pairing again restores the same member.
    carter = await server.register('Kaito');
    assert.equal((await household(carter.deviceToken)).me, carter.memberId);
  });

  it('removes a member but keeps their chat messages', async () => {
    const send = (payload: Record<string, unknown>) =>
      server.app.inject({ method: 'POST', url: '/api/messages', headers: bearer(aiko.deviceToken), payload });
    await send({ clientId: 'a-1', kind: 'text', text: 'ただいま' });
    const spokenId = await uploadVoice(server, aiko.deviceToken);
    await send({ clientId: 'a-2', kind: 'voice', text: '', audioId: spokenId });
    const unsentId = await uploadVoice(server, aiko.deviceToken);
    await server.app.inject({
      method: 'POST',
      url: '/api/stats',
      headers: bearer(aiko.deviceToken),
      payload: { days: [], streak: 3, kanjiKnown: 1, knownKanji: ['日'], phase: 1 },
    });
    await server.app.inject({
      method: 'POST',
      url: '/api/quizzes',
      headers: bearer(carter.deviceToken),
      payload: { toMemberId: aiko.memberId, items: [{ char: '水' }] },
    });

    const removed = await admin('remove', 'Aiko');
    assert.equal(removed.code, 0);
    assert.equal(
      removed.out,
      'Removed "Aiko": signed out 1 device, deleted their stats and quizzes.\n' +
        'Their 2 chat messages stay, shown as from a former member.',
    );

    assert.equal((await get('/api/household', aiko.deviceToken)).statusCode, 401);
    const home = await household(carter.deviceToken);
    assert.deepEqual(
      home.members.map((m) => m.member.id),
      [carter.memberId],
    );
    const quizzes = (await get('/api/quizzes', carter.deviceToken)).json<QuizzesResponse>();
    assert.deepEqual(quizzes.sent, []);

    const messages = (await get('/api/messages', carter.deviceToken)).json<ChatMessage[]>();
    assert.deepEqual(
      messages.map((m) => [m.memberId, m.clientId]),
      [
        [aiko.memberId, 'a-1'],
        [aiko.memberId, 'a-2'],
      ],
    );
    // The recording in the chat stays playable; the one never sent is gone with its file.
    assert.equal((await get(`/api/voice/${spokenId}`, carter.deviceToken)).statusCode, 200);
    assert.equal(server.store.getVoice(unsentId), undefined);
    assert.deepEqual(await readdir(dataPaths(server.dataDir).voice), [`${spokenId}.webm`]);

    // The name is free again: registering it would make a new member.
    assert.equal(server.store.findMemberByName('Aiko'), undefined);
  });

  it('explains bad input', async () => {
    const unknown = await admin('remove', 'Nobody');
    assert.equal(unknown.code, 1);
    assert.equal(unknown.err, 'No member "Nobody". Run "list" to see the household.');

    const command = await admin('promote', 'Kaito');
    assert.equal(command.code, 2);
    assert.match(command.err, /^Unknown command "promote"\.\n\nUsage:/);

    const unquoted = await admin('rename', 'Kaito', 'Kaito', 'Caldwell');
    assert.equal(unquoted.code, 2);
    assert.match(unquoted.err, /^Usage: rename <member> <new name>/);

    assert.equal((await admin()).code, 2);
    const help = await admin('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /household-name \[<name>\]/);
  });

  it('refuses to create a database in the wrong place', async () => {
    const missing = path.join(tmpdir(), `issho-missing-${process.pid}`);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdmin(['list'], {
      env: { DATA_DIR: missing },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /^No database at .*issho\.db\. Set DATA_DIR/);
    await assert.rejects(readdir(missing), { code: 'ENOENT' });
  });

  it('waits while the server is writing', async () => {
    const serverWrite = new DatabaseSync(dataPaths(server.dataDir).database, { timeout: 5000 });
    serverWrite.exec('BEGIN IMMEDIATE');
    const command = cli(server.dataDir, 'household-name', 'Busy home');
    await tick(400);
    serverWrite.exec('COMMIT');
    serverWrite.close();
    assert.equal((await command).stdout.trim(), 'Household name set to "Busy home"');
  });
});
