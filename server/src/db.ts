import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ChatMessage,
  DayStats,
  Member,
  MessageKind,
  Quiz,
  QuizItem,
  StatsUploadRequest,
} from '../../shared/api.ts';

/**
 * Append-only: each entry upgrades the schema by one `user_version`. Never edit a shipped entry.
 * They run with foreign keys off (so tables can be rebuilt) and are checked before committing.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    joined_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE devices (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX devices_member ON devices(member_id);

  CREATE TABLE day_stats (
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    study_minutes REAL NOT NULL,
    reviews INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    new_items INTEGER NOT NULL,
    session_complete INTEGER NOT NULL,
    PRIMARY KEY (member_id, date)
  ) WITHOUT ROWID;

  CREATE TABLE member_stats (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    streak INTEGER NOT NULL,
    kanji_known INTEGER NOT NULL,
    known_kanji TEXT NOT NULL,
    phase INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE voice (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'voice', 'system')),
    text TEXT NOT NULL,
    transcript TEXT,
    audio_id TEXT REFERENCES voice(id),
    UNIQUE (member_id, client_id)
  );

  CREATE TABLE quizzes (
    id TEXT PRIMARY KEY,
    from_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    to_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    items TEXT NOT NULL,
    result TEXT
  );
  CREATE INDEX quizzes_to ON quizzes(to_member_id, created_at);
  CREATE INDEX quizzes_from ON quizzes(from_member_id, created_at);
  `,
  `
  -- The chat outlives a removed member: messages and their recordings stop referencing members
  -- (removing one used to cascade into the chat history).
  CREATE TABLE voice_v2 (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO voice_v2 (id, member_id, content_type, file_name, size, created_at)
    SELECT id, member_id, content_type, file_name, size, created_at FROM voice;
  DROP TABLE voice;
  ALTER TABLE voice_v2 RENAME TO voice;

  CREATE TABLE messages_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'voice', 'system')),
    text TEXT NOT NULL,
    transcript TEXT,
    audio_id TEXT REFERENCES voice(id),
    UNIQUE (member_id, client_id)
  );
  INSERT INTO messages_v2 (id, client_id, member_id, created_at, kind, text, transcript, audio_id)
    SELECT id, client_id, member_id, created_at, kind, text, transcript, audio_id FROM messages;
  -- Keep the AUTOINCREMENT high-water mark: message ids are the phones' sync cursor and must never be reused.
  DELETE FROM sqlite_sequence WHERE name = 'messages_v2';
  UPDATE sqlite_sequence SET name = 'messages_v2' WHERE name = 'messages';
  DROP TABLE messages;
  ALTER TABLE messages_v2 RENAME TO messages;
  CREATE INDEX messages_audio ON messages(audio_id);

  -- The study day of the upload that last set the streak, to merge a member's devices.
  ALTER TABLE member_stats ADD COLUMN reported_day TEXT;

  -- Household settings changed from the admin CLI.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  -- Each device's latest upload, so a phone that was reset (or restored from an older backup) can
  -- lower its own numbers. day_stats and member_stats stay the merged view per member: recomputed
  -- from the member's current devices on every upload, and kept when a device is signed out.
  CREATE TABLE device_day_stats (
    token_hash TEXT NOT NULL REFERENCES devices(token_hash) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    study_minutes REAL NOT NULL,
    reviews INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    new_items INTEGER NOT NULL,
    session_complete INTEGER NOT NULL,
    PRIMARY KEY (token_hash, date)
  ) WITHOUT ROWID;
  CREATE INDEX device_day_stats_member ON device_day_stats(member_id, date);

  CREATE TABLE device_stats (
    token_hash TEXT PRIMARY KEY REFERENCES devices(token_hash) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    streak INTEGER NOT NULL,
    kanji_known INTEGER NOT NULL,
    known_kanji TEXT NOT NULL,
    phase INTEGER NOT NULL,
    reported_day TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX device_stats_member ON device_stats(member_id);

  -- When the sender wrote a message on their phone, which may be long before it reached the server.
  ALTER TABLE messages ADD COLUMN written_at TEXT;
  `,
];

const HOUSEHOLD_NAME_SETTING = 'household_name';
const HOUSEHOLD_ID_SETTING = 'household_id';
/** How far back a message's writtenAt may go: about as long as a phone sits offline. */
export const MAX_WRITTEN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

type MemberRow = { id: string; name: string; joined_at: string; last_seen_at: string | null };
type DayRow = {
  date: string;
  study_minutes: number;
  reviews: number;
  correct: number;
  new_items: number;
  session_complete: number;
};
type MemberStatsRow = {
  streak: number;
  kanji_known: number;
  known_kanji: string;
  phase: number;
  reported_day: string | null;
  updated_at: string;
};
type DeviceStatsRow = MemberStatsRow & { token_hash: string };
type MessageRow = {
  id: number;
  client_id: string;
  member_id: string;
  created_at: string;
  written_at: string | null;
  kind: MessageKind;
  text: string;
  transcript: string | null;
  audio_id: string | null;
};
type VoiceRow = {
  id: string;
  member_id: string;
  content_type: string;
  file_name: string;
  size: number;
  created_at: string;
};
type QuizRow = {
  id: string;
  from_member_id: string;
  to_member_id: string;
  created_at: string;
  items: string;
  result: string | null;
};

export interface MemberSummary {
  streak: number;
  kanjiKnown: number;
  knownKanji: string[];
  phase: number;
  updatedAt: string;
}

export interface VoiceRecord {
  id: string;
  memberId: string;
  contentType: string;
  fileName: string;
  size: number;
  createdAt: string;
}

export interface RemovedMember {
  devices: number;
  /** Their chat messages, which stay in the history. */
  messagesKept: number;
  /** Recordings no message used, deleted with them: the caller removes these files. */
  voiceFiles: string[];
}

export interface NewMessage {
  clientId: string;
  memberId: string;
  createdAt: string;
  /** When it was written on the phone; the caller keeps it within MAX_WRITTEN_BEFORE_MS of createdAt. */
  writtenAt?: string;
  kind: MessageKind;
  text: string;
  transcript?: string;
  audioId?: string;
}

/** Same-name matching for re-registration: case-, width- and whitespace-insensitive. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** All persistence for the household, over node:sqlite (synchronous, single connection). */
export class Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  /** `file` is a path, or ':memory:' for tests. */
  constructor(file: string) {
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // Members and devices

  getMember(id: string): Member | undefined {
    const row = this.sql('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
    return row && toMember(row);
  }

  findMemberByName(name: string): Member | undefined {
    const row = this.sql('SELECT * FROM members WHERE name_key = ?').get(nameKey(name)) as
      | MemberRow
      | undefined;
    return row && toMember(row);
  }

  listMembers(): Member[] {
    const rows = this.sql('SELECT * FROM members ORDER BY joined_at, rowid').all() as MemberRow[];
    return rows.map(toMember);
  }

  createMember(name: string, now: Date): Member {
    const row = this.sql(
      'INSERT INTO members (id, name, name_key, joined_at) VALUES (?, ?, ?, ?) RETURNING *',
    ).get(randomUUID(), name, nameKey(name), now.toISOString()) as MemberRow;
    return toMember(row);
  }

  /** Records activity, writing at most once per `resolutionMs` to keep reads cheap. */
  touchMember(id: string, now: Date, resolutionMs = 0): void {
    const threshold = new Date(now.getTime() - resolutionMs).toISOString();
    this.sql(
      'UPDATE members SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)',
    ).run(now.toISOString(), id, threshold);
  }

  addDevice(memberId: string, tokenHash: string, now: Date): void {
    this.sql('INSERT INTO devices (token_hash, member_id, created_at) VALUES (?, ?, ?)').run(
      tokenHash,
      memberId,
      now.toISOString(),
    );
  }

  memberForTokenHash(tokenHash: string): Member | undefined {
    const row = this.sql(
      'SELECT m.* FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token_hash = ?',
    ).get(tokenHash) as MemberRow | undefined;
    return row && toMember(row);
  }

  deviceCount(memberId: string): number {
    const row = this.sql('SELECT COUNT(*) AS count FROM devices WHERE member_id = ?').get(memberId) as {
      count: number;
    };
    return row.count;
  }

  /** The caller checks that no other member already has the name (name_key is unique). */
  renameMember(id: string, name: string): Member {
    const row = this.sql('UPDATE members SET name = ?, name_key = ? WHERE id = ? RETURNING *').get(
      name,
      nameKey(name),
      id,
    ) as MemberRow;
    return toMember(row);
  }

  /** Signs out one device (its token stops working). Returns false when it wasn't paired. */
  removeDevice(tokenHash: string): boolean {
    return Number(this.sql('DELETE FROM devices WHERE token_hash = ?').run(tokenHash).changes) > 0;
  }

  /** Signs out every device of a member. Returns how many there were. */
  revokeDevices(memberId: string): number {
    return Number(this.sql('DELETE FROM devices WHERE member_id = ?').run(memberId).changes);
  }

  /** Deletes a member with their devices, stats and quizzes. Their chat messages stay. */
  removeMember(id: string): RemovedMember {
    return this.transaction(() => {
      const devices = this.deviceCount(id);
      const { count: messagesKept } = this.sql('SELECT COUNT(*) AS count FROM messages WHERE member_id = ?').get(
        id,
      ) as { count: number };
      const voice = this.sql(`
        DELETE FROM voice
        WHERE member_id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE audio_id = voice.id)
        RETURNING file_name
      `).all(id) as { file_name: string }[];
      this.sql('DELETE FROM members WHERE id = ?').run(id);
      return { devices, messagesKept, voiceFiles: voice.map((row) => row.file_name) };
    });
  }

  // Household settings

  /** Set with the admin CLI; when unset the server uses HOUSEHOLD_NAME. */
  householdName(): string | undefined {
    const row = this.sql('SELECT value FROM settings WHERE key = ?').get(HOUSEHOLD_NAME_SETTING) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setHouseholdName(name: string): void {
    this.sql(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(HOUSEHOLD_NAME_SETTING, name);
  }

  /**
   * A random id for this household's data, made on first use. It changes only when the data is
   * started afresh, which tells a phone pairing again whether its cached chat still belongs here.
   */
  householdId(): string {
    this.sql('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(HOUSEHOLD_ID_SETTING, randomUUID());
    const row = this.sql('SELECT value FROM settings WHERE key = ?').get(HOUSEHOLD_ID_SETTING) as { value: string };
    return row.value;
  }

  // Study stats

  /**
   * Saves a device's upload and refreshes the member's merged stats. A member can study on two
   * devices, each uploading its own numbers for the same days, so no device's upload may wipe out
   * another's: each day keeps the largest value of every field across the member's current
   * devices. A device's upload does replace its own earlier one, so a phone that was reset (or
   * restored from an older backup) lowers what it reported before. Days a device no longer sends
   * keep their merged values, so the history behind the shared streak survives. `reportedDay` is
   * the uploading device's study day (null when unknown), which decides whose streak counts
   * (see mergeDevices).
   */
  saveStats(
    memberId: string,
    tokenHash: string,
    upload: StatsUploadRequest,
    now: Date,
    reportedDay: string | null,
  ): void {
    const upsertDeviceDay = this.sql(`
      INSERT INTO device_day_stats
        (token_hash, member_id, date, study_minutes, reviews, correct, new_items, session_complete)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (token_hash, date) DO UPDATE SET
        study_minutes = excluded.study_minutes,
        reviews = excluded.reviews,
        correct = excluded.correct,
        new_items = excluded.new_items,
        session_complete = excluded.session_complete
    `);
    const mergeDay = this.sql(`
      INSERT INTO day_stats (member_id, date, study_minutes, reviews, correct, new_items, session_complete)
      SELECT member_id, date, MAX(study_minutes), MAX(reviews), MAX(correct), MAX(new_items), MAX(session_complete)
      FROM device_day_stats WHERE member_id = ? AND date = ?
      GROUP BY member_id, date
      ON CONFLICT (member_id, date) DO UPDATE SET
        study_minutes = excluded.study_minutes,
        reviews = excluded.reviews,
        correct = excluded.correct,
        new_items = excluded.new_items,
        session_complete = excluded.session_complete
    `);
    const upsertDevice = this.sql(`
      INSERT INTO device_stats (token_hash, member_id, streak, kanji_known, known_kanji, phase, reported_day, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (token_hash) DO UPDATE SET
        streak = excluded.streak,
        kanji_known = excluded.kanji_known,
        known_kanji = excluded.known_kanji,
        phase = excluded.phase,
        reported_day = excluded.reported_day,
        updated_at = excluded.updated_at
    `);
    const upsertSummary = this.sql(`
      INSERT INTO member_stats (member_id, streak, kanji_known, known_kanji, phase, reported_day, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (member_id) DO UPDATE SET
        streak = excluded.streak,
        kanji_known = excluded.kanji_known,
        known_kanji = excluded.known_kanji,
        phase = excluded.phase,
        reported_day = excluded.reported_day,
        updated_at = excluded.updated_at
    `);
    const updatedAt = now.toISOString();
    this.transaction(() => {
      for (const day of upload.days) {
        upsertDeviceDay.run(
          tokenHash,
          memberId,
          day.date,
          day.studyMinutes,
          day.reviews,
          day.correct,
          day.newItems,
          day.sessionComplete ? 1 : 0,
        );
        mergeDay.run(memberId, day.date);
      }
      upsertDevice.run(
        tokenHash,
        memberId,
        upload.streak,
        upload.kanjiKnown,
        JSON.stringify([...new Set(upload.knownKanji)]),
        upload.phase,
        reportedDay,
        updatedAt,
      );
      const devices = this.sql(`
        SELECT s.* FROM device_stats s JOIN devices d ON d.token_hash = s.token_hash
        WHERE s.member_id = ? ORDER BY d.created_at, d.rowid
      `).all(memberId) as DeviceStatsRow[];
      const summary = mergeDevices(devices);
      upsertSummary.run(
        memberId,
        summary.streak,
        summary.kanjiKnown,
        JSON.stringify(summary.knownKanji),
        summary.phase,
        summary.reportedDay,
        updatedAt,
      );
    });
  }

  dayStats(memberId: string, from: string, to: string): DayStats[] {
    const rows = this.sql(
      'SELECT * FROM day_stats WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY date',
    ).all(memberId, from, to) as DayRow[];
    return rows.map((row) => ({
      date: row.date,
      studyMinutes: row.study_minutes,
      reviews: row.reviews,
      correct: row.correct,
      newItems: row.new_items,
      sessionComplete: row.session_complete === 1,
    }));
  }

  memberSummary(memberId: string): MemberSummary | undefined {
    const row = this.sql('SELECT * FROM member_stats WHERE member_id = ?').get(memberId) as
      | MemberStatsRow
      | undefined;
    return (
      row && {
        streak: row.streak,
        kanjiKnown: row.kanji_known,
        knownKanji: JSON.parse(row.known_kanji) as string[],
        phase: row.phase,
        updatedAt: row.updated_at,
      }
    );
  }

  /** The latest study day any member has reported, ignoring days after `notAfter`. */
  newestDay(notAfter: string): string | undefined {
    const row = this.sql('SELECT MAX(date) AS date FROM day_stats WHERE date <= ?').get(notAfter) as {
      date: string | null;
    };
    return row.date ?? undefined;
  }

  /** Dates on which every current member has a completed session. */
  daysEveryoneCompleted(): Set<string> {
    const rows = this.sql(`
      SELECT date FROM day_stats
      WHERE session_complete = 1
      GROUP BY date
      HAVING COUNT(*) = (SELECT COUNT(*) FROM members)
    `).all() as { date: string }[];
    return new Set(rows.map((row) => row.date));
  }

  // Chat

  findMessage(memberId: string, clientId: string): ChatMessage | undefined {
    const row = this.sql('SELECT * FROM messages WHERE member_id = ? AND client_id = ?').get(
      memberId,
      clientId,
    ) as MessageRow | undefined;
    return row && toMessage(row);
  }

  insertMessage(message: NewMessage): ChatMessage {
    const row = this.sql(`
      INSERT INTO messages (client_id, member_id, created_at, written_at, kind, text, transcript, audio_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      message.clientId,
      message.memberId,
      message.createdAt,
      message.writtenAt ?? null,
      message.kind,
      message.text,
      message.transcript ?? null,
      message.audioId ?? null,
    ) as MessageRow;
    return toMessage(row);
  }

  /** Messages with id > `after`, oldest first. */
  listMessages(after: number, limit: number): ChatMessage[] {
    const rows = this.sql('SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT ?').all(
      after,
      limit,
    ) as MessageRow[];
    return rows.map(toMessage);
  }

  // Voice

  insertVoice(voice: VoiceRecord): void {
    this.sql(
      'INSERT INTO voice (id, member_id, content_type, file_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(voice.id, voice.memberId, voice.contentType, voice.fileName, voice.size, voice.createdAt);
  }

  getVoice(id: string): VoiceRecord | undefined {
    const row = this.sql('SELECT * FROM voice WHERE id = ?').get(id) as VoiceRow | undefined;
    return (
      row && {
        id: row.id,
        memberId: row.member_id,
        contentType: row.content_type,
        fileName: row.file_name,
        size: row.size,
        createdAt: row.created_at,
      }
    );
  }

  voiceFileNames(): Set<string> {
    const rows = this.sql('SELECT file_name FROM voice').all() as { file_name: string }[];
    return new Set(rows.map((row) => row.file_name));
  }

  /** Deletes recordings created before `createdBefore` that no message uses; returns their file names. */
  deleteOrphanedVoice(createdBefore: string): string[] {
    const rows = this.sql(`
      DELETE FROM voice
      WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM messages WHERE audio_id = voice.id)
      RETURNING file_name
    `).all(createdBefore) as { file_name: string }[];
    return rows.map((row) => row.file_name);
  }

  // Quizzes

  insertQuiz(quiz: Omit<Quiz, 'id' | 'result'>): Quiz {
    const row = this.sql(`
      INSERT INTO quizzes (id, from_member_id, to_member_id, created_at, items)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      randomUUID(),
      quiz.fromMemberId,
      quiz.toMemberId,
      quiz.createdAt,
      JSON.stringify(quiz.items.map((item) => ({ char: item.char }))),
    ) as QuizRow;
    return toQuiz(row);
  }

  getQuiz(id: string): Quiz | undefined {
    const row = this.sql('SELECT * FROM quizzes WHERE id = ?').get(id) as QuizRow | undefined;
    return row && toQuiz(row);
  }

  /** Newest first. */
  listQuizzes(box: 'inbox' | 'sent', memberId: string, limit: number): Quiz[] {
    const column = box === 'inbox' ? 'to_member_id' : 'from_member_id';
    const rows = this.sql(
      `SELECT * FROM quizzes WHERE ${column} = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(memberId, limit) as QuizRow[];
    return rows.map(toQuiz);
  }

  setQuizResult(id: string, result: NonNullable<Quiz['result']>): Quiz {
    const row = this.sql('UPDATE quizzes SET result = ? WHERE id = ? RETURNING *').get(
      JSON.stringify(result),
      id,
    ) as QuizRow;
    return toQuiz(row);
  }

  // Internals

  private sql(source: string): StatementSync {
    let statement = this.statements.get(source);
    if (!statement) {
      statement = this.db.prepare(source);
      this.statements.set(source, statement);
    }
    return statement;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private userVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  private migrate(): void {
    const version = this.userVersion();
    if (version > MIGRATIONS.length) {
      throw new Error(
        `Database schema version ${version} is newer than this server understands (${MIGRATIONS.length}). Upgrade the server.`,
      );
    }
    if (version === MIGRATIONS.length) return;

    // Rebuilding a table must not fire ON DELETE actions. The switch only works outside a transaction.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      let migrated = true;
      while (migrated) migrated = this.transaction(() => this.applyNextMigration());
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Applies one migration; false when already up to date. The version is read inside the
   * transaction because the server and the admin CLI may open the same file at once.
   */
  private applyNextMigration(): boolean {
    const version = this.userVersion();
    if (version >= MIGRATIONS.length) return false;
    this.db.exec(MIGRATIONS[version]);
    if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error(`Database migration ${version + 1} left broken references; nothing was changed.`);
    }
    this.db.exec(`PRAGMA user_version = ${version + 1}`);
    return true;
  }
}

interface Summary {
  streak: number;
  kanjiKnown: number;
  knownKanji: string[];
  phase: number;
  reportedDay: string | null;
}

/**
 * A member's summary from their devices' latest uploads (oldest device first). Known kanji are
 * the union and the phase the highest; the count is never below the union's size. A streak drops
 * when a day is missed, so the device reporting the latest study day decides it; within one day
 * it only grows, so there the larger wins. A device that sent no study day can't be ordered, so
 * it decides only when no device sent one (the latest upload wins then).
 */
function mergeDevices(devices: readonly DeviceStatsRow[]): Summary {
  const knownKanji = [...new Set(devices.flatMap((device) => JSON.parse(device.known_kanji) as string[]))];
  const dated = devices.filter((device) => device.reported_day !== null);
  const latestDay = dated.reduce<string | null>(
    (max, device) => (max === null || device.reported_day! > max ? device.reported_day : max),
    null,
  );
  const streak =
    latestDay !== null
      ? Math.max(...dated.filter((device) => device.reported_day === latestDay).map((device) => device.streak))
      : [...devices].sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0)).at(-1)
          ?.streak ?? 0;
  return {
    streak,
    kanjiKnown: Math.max(knownKanji.length, ...devices.map((device) => device.kanji_known)),
    knownKanji,
    phase: Math.max(1, ...devices.map((device) => device.phase)),
    reportedDay: latestDay,
  };
}

function toMember(row: MemberRow): Member {
  return { id: row.id, name: row.name, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at };
}

function toMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    clientId: row.client_id,
    memberId: row.member_id,
    createdAt: row.created_at,
    kind: row.kind,
    text: row.text,
  };
  if (row.written_at !== null) message.writtenAt = row.written_at;
  if (row.transcript !== null) message.transcript = row.transcript;
  if (row.audio_id !== null) message.audioId = row.audio_id;
  return message;
}

function toQuiz(row: QuizRow): Quiz {
  const quiz: Quiz = {
    id: row.id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    createdAt: row.created_at,
    items: JSON.parse(row.items) as QuizItem[],
  };
  if (row.result !== null) quiz.result = JSON.parse(row.result) as Quiz['result'];
  return quiz;
}
