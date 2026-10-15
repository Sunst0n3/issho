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

    // Messages from before the upgrade have no writtenAt.
    assert.equal('writtenAt' in store.listMessages(0, 1)[0], false);
    // Stats from before the upgrade stay until a device uploads; its own numbers then count.
    store.saveStats(
      'm-aiko',
      'h-aiko',
      { days: [{ date: '2026-10-02', studyMinutes: 5, reviews: 4, correct: 3, newItems: 1, sessionComplete: true }], streak: 1, kanjiKnown: 0, knownKanji: [], phase: 1 },
      new Date('2026-10-02T12:00:00.000Z'),
      '2026-10-02',
    );
    assert.deepEqual(store.memberSummary('m-aiko')?.knownKanji, []);
    assert.equal(store.dayStats('m-aiko', '2026-10-02', '2026-10-02')[0]?.reviews, 4);

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

  it('upgrades a version 3 database to v2 (migration 4), keeping every row with defaults', () => {
    const file = path.join(dir, 'v3.db');
    const old = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    for (const migration of MIGRATIONS.slice(0, 3)) old.exec(migration);
    old.exec(`
      PRAGMA user_version = 3;
      INSERT INTO members (id, name, name_key, joined_at) VALUES ('m-ken', 'Ken', 'ken', '2026-10-01T00:00:00.000Z');
      INSERT INTO devices (token_hash, member_id, created_at) VALUES ('h-ken', 'm-ken', '2026-10-01T00:00:00.000Z');
      INSERT INTO day_stats (member_id, date, study_minutes, reviews, correct, new_items, session_complete) VALUES
        ('m-ken', '2026-10-13', 12, 30, 25, 3, 1),
        ('m-ken', '2026-10-14', 4, 8, 6, 0, 0);
      INSERT INTO device_day_stats (token_hash, member_id, date, study_minutes, reviews, correct, new_items, session_complete) VALUES
        ('h-ken', 'm-ken', '2026-10-13', 12, 30, 25, 3, 1);
      INSERT INTO member_stats (member_id, streak, kanji_known, known_kanji, phase, updated_at)
        VALUES ('m-ken', 2, 1, '["日"]', 2, '2026-10-14T00:00:00.000Z');
      INSERT INTO device_stats (token_hash, member_id, streak, kanji_known, known_kanji, phase, reported_day, updated_at)
        VALUES ('h-ken', 'm-ken', 2, 1, '["日"]', 2, '2026-10-14', '2026-10-14T00:00:00.000Z');
      INSERT INTO quizzes (id, from_member_id, to_member_id, created_at, items)
        VALUES ('q-1', 'm-ken', 'm-ken', '2026-10-14T00:00:00.000Z', '[{"char":"日"}]');
      INSERT INTO messages (client_id, member_id, created_at, kind, text) VALUES ('c-1', 'm-ken', '2026-10-14T00:00:00.000Z', 'text', 'やあ');
    `);
    old.close();

    const store = new Store(file);
    assert.equal(userVersion(file), 4);
    assert.deepEqual(store.dayStats('m-ken', '2026-10-13', '2026-10-14'), [
      { date: '2026-10-13', studyMinutes: 12, reviews: 30, correct: 25, newItems: 3, sessionComplete: true, minimumDone: true, togetherMinutes: 0, restToken: false, accuracyShared: false },
      { date: '2026-10-14', studyMinutes: 4, reviews: 8, correct: 6, newItems: 0, sessionComplete: false, minimumDone: false, togetherMinutes: 0, restToken: false, accuracyShared: false },
    ]);
    assert.deepEqual(store.minimumDates('m-ken', '2026-10-01', '2026-10-31'), new Set(['2026-10-13']));
    assert.deepEqual(store.memberSummary('m-ken'), {
      streak: 2,
      kanjiKnown: 1,
      knownKanji: ['日'],
      phase: 2,
      progress: null,
      updatedAt: '2026-10-14T00:00:00.000Z',
    });
    const quiz = store.getQuiz('q-1');
    assert.equal(quiz?.kind, 'kanji');
    assert.deepEqual(quiz?.items, [{ char: '日' }]);
    assert.equal('tag' in store.listMessages(0, 1)[0], false);
    assert.deepEqual(store.listTogetherEvents(), []);

    // The new tables work, and removing a member removes their events and reports.
    assert.equal(
      store.insertTogetherEvent({ memberId: 'm-ken', clientId: 'e-1', week: '2026-10-12', createdAt: '2026-10-14T00:00:00.000Z', event: { type: 'goal', goal: { text: 'x', targetDate: '2026-10-31' } } }),
      true,
    );
    assert.equal(
      store.insertTogetherEvent({ memberId: 'm-ken', clientId: 'e-1', week: '2026-10-12', createdAt: '2026-10-15T00:00:00.000Z', event: { type: 'goal', goal: { text: 'y', targetDate: '2026-10-31' } } }),
      false,
    );
    store.insertAiReport('m-ken', { kind: 'check', text: 'やあ' }, new Date('2026-10-14T00:00:00.000Z'));
    assert.equal(store.listTogetherEvents().length, 1);
    store.removeMember('m-ken');
    assert.deepEqual(store.listTogetherEvents(), []);
    assert.deepEqual(store.listAiReports(5), []);
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
