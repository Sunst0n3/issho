import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, Store } from '../src/db.ts';

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

  it('upgrades a version 1 database, after which removing a member keeps the chat', () => {
    const file = path.join(dir, 'v1.db');
    const old = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    old.exec(MIGRATIONS[0]);
    old.exec(`
      PRAGMA user_version = 1;
      INSERT INTO members (id, name, name_key, joined_at) VALUES
        ('m-carter', 'Carter', 'carter', '2026-10-01T00:00:00.000Z'),
        ('m-aiko', 'Aiko', 'aiko', '2026-10-01T00:00:00.000Z');
      INSERT INTO devices (token_hash, member_id, created_at) VALUES ('h-aiko', 'm-aiko', '2026-10-01T00:00:00.000Z');
      INSERT INTO voice (id, member_id, content_type, file_name, size, created_at) VALUES
        ('v-sent', 'm-aiko', 'audio/webm', 'v-sent.webm', 64, '2026-10-02T00:00:00.000Z'),
        ('v-unsent', 'm-aiko', 'audio/webm', 'v-unsent.webm', 64, '2026-10-02T00:00:00.000Z');
      INSERT INTO messages (client_id, member_id, created_at, kind, text, audio_id) VALUES
        ('c-1', 'm-carter', '2026-10-02T00:00:00.000Z', 'text', 'おはよう', NULL),
        ('a-1', 'm-aiko', '2026-10-02T00:01:00.000Z', 'voice', '', 'v-sent'),
        ('a-2', 'm-aiko', '2026-10-02T00:02:00.000Z', 'text', 'deleted', NULL);
      DELETE FROM messages WHERE client_id = 'a-2';
      INSERT INTO member_stats (member_id, streak, kanji_known, known_kanji, phase, updated_at)
        VALUES ('m-aiko', 4, 1, '["日"]', 2, '2026-10-02T00:00:00.000Z');
    `);
    old.close();

    const store = new Store(file);
    assert.equal(userVersion(file), MIGRATIONS.length);
    assert.deepEqual(
      store.listMessages(0, 10).map((m) => [m.id, m.clientId, m.memberId, m.audioId]),
      [
        [1, 'c-1', 'm-carter', undefined],
        [2, 'a-1', 'm-aiko', 'v-sent'],
      ],
    );
    assert.equal(store.memberSummary('m-aiko')?.streak, 4);
    // Ids continue after the highest ever handed out (3), so phones' sync cursors stay valid.
    const next = store.insertMessage({ clientId: 'c-2', memberId: 'm-carter', createdAt: '2026-10-03T00:00:00.000Z', kind: 'text', text: 'ただいま' });
    assert.equal(next.id, 4);

    assert.deepEqual(store.removeMember('m-aiko'), { devices: 1, messagesKept: 1, voiceFiles: ['v-unsent.webm'] });
    assert.equal(store.getMember('m-aiko'), undefined);
    assert.equal(store.memberSummary('m-aiko'), undefined);
    assert.equal(store.memberForTokenHash('h-aiko'), undefined);
    assert.equal(store.listMessages(0, 10).find((m) => m.clientId === 'a-1')?.memberId, 'm-aiko');
    assert.ok(store.getVoice('v-sent'));

    // Foreign keys are back on after the migration.
    assert.throws(() =>
      store.insertMessage({ clientId: 'c-3', memberId: 'm-carter', createdAt: '2026-10-03T00:00:00.000Z', kind: 'voice', text: '', audioId: 'missing' }),
    );
    store.close();
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
