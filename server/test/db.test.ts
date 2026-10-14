import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';

describe('database file', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'issho-db-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const userVersion = (file: string) => {
    const db = new DatabaseSync(file);
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  };

  it('keeps its data and schema across restarts', () => {
    const file = path.join(dir, 'restart.db');
    const first = new Store(file);
    const member = first.createMember('Carter', new Date('2026-10-14T03:00:00Z'));
    first.addDevice(member.id, 'hash', new Date());
    first.close();
    const version = userVersion(file);
    assert.ok(version >= 1);

    // Opening an up-to-date database runs no migration again (re-creating a table would throw).
    const second = new Store(file);
    assert.deepEqual(second.getMember(member.id), member);
    assert.equal(second.memberForTokenHash('hash')?.id, member.id);
    second.close();
    assert.equal(userVersion(file), version);
  });

  it('refuses a database from a newer server', () => {
    const file = path.join(dir, 'newer.db');
    new Store(file).close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 999');
    db.close();
    assert.throws(() => new Store(file), /newer than this server understands/);
  });
});
