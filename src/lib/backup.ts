// Backup/restore of everything this device has learned (all IndexedDB tables) as
// one JSON file, plus a request for persistent storage so the browser doesn't
// evict progress under storage pressure.
//
// Dates are written as { "$date": ISO } so they come back as Date objects. Audio
// of unsent voice messages is not exported (those rows are dropped), and neither is
// the device token: a stray backup file must not grant access to the household.
//
// Restoring replaces learning progress and preferences. The chat cache and outbox
// belong to this device's home-server pairing, which restoring keeps: backup chat
// rows are merged in only when the backup was made by the same member (member ids
// are random per server), otherwise they would show another household's messages,
// throw off the catch-up cursor, and post old unsent texts to the wrong chat.

import type { Table } from 'dexie';
import { db, getSettings } from './db.ts';
import type { ItemKind, Settings } from './types.ts';

const FORMAT = 'issho-backup';
const VERSION = 1;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

interface BackupFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

type Row = Record<string, unknown>;

const isStr = (v: unknown) => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());

const ITEM_KINDS = new Set<unknown>(['kana', 'radical', 'kanji', 'word', 'vocab', 'grammar', 'sentence'] satisfies ItemKind[]);
/** FSRS fields the scheduler does arithmetic on; a string or null here would silently corrupt scheduling. */
const CARD_NUMBERS = ['stability', 'difficulty', 'state', 'reps', 'lapses'] as const;
const DAY_NUMBERS = ['studyMs', 'reviews', 'correct', 'newItems'] as const;
/** This device's conversation with its paired household (see the top of this file). */
const CHAT_TABLES = new Set(['messages', 'outbox']);

/** Per-table row checks after decoding. Tables marked required must be present in the file. */
const TABLE_RULES: Record<string, { required: boolean; valid: (r: Row) => boolean }> = {
  items: { required: true, valid: (r) => isStr(r.id) && ITEM_KINDS.has(r.kind) && typeof r.key === 'string' && isDate(r.introducedAt) },
  cards: {
    required: true,
    valid: (r) => isStr(r.id) && isStr(r.itemId) && ITEM_KINDS.has(r.kind) && isStr(r.type) && isDate(r.due)
      && CARD_NUMBERS.every((k) => isNum(r[k])),
  },
  reviewLogs: { required: true, valid: (r) => isStr(r.cardId) && isDate(r.reviewedAt) && typeof r.grade === 'number' },
  days: {
    required: true,
    valid: (r) => typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
      && DAY_NUMBERS.every((k) => isNum(r[k])) && typeof r.sessionComplete === 'boolean',
  },
  settings: { required: true, valid: (r) => r.id === 'me' },
  outbox: { required: false, valid: (r) => isStr(r.clientId) && isDate(r.createdAt) && r.kind === 'text' },
  messages: { required: false, valid: (r) => typeof r.id === 'number' && isStr(r.clientId) },
  savedSentences: { required: false, valid: (r) => isStr(r.id) && typeof r.jp === 'string' && isDate(r.savedAt) },
};

function encode(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Blob) return undefined;
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) {
      const e = encode(v);
      if (e !== undefined) out[k] = e;
    }
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const obj = value as Row;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$date' && typeof obj.$date === 'string') {
      const d = new Date(obj.$date);
      if (Number.isNaN(d.getTime())) throw new BackupError(`The backup contains an invalid date: ${obj.$date}`);
      return d;
    }
    const out: Row = {};
    for (const k of keys) {
      // Assigning it would set the row's prototype, letting inherited fields pass validation.
      if (k === '__proto__') continue;
      out[k] = decode(obj[k]);
    }
    return out;
  }
  return value;
}

/** 'issho-backup-2026-10-14.json' */
export function backupFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `issho-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Everything on this device as a JSON Blob, ready to download or share. */
export async function exportBackup(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {};
  await db.transaction('r', db.tables, async () => {
    for (const table of db.tables) {
      let rows = (await table.toArray()) as Row[];
      if (table.name === 'outbox') rows = rows.filter((r) => r.kind === 'text');
      if (table.name === 'settings') rows = rows.map(({ deviceToken: _token, ...rest }) => rest);
      tables[table.name] = rows.map((r) => encode(r));
    }
  });
  const file: BackupFile = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), tables };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export interface BackupImport {
  exportedAt: Date;
  /** Rows per table that will be restored (chat tables are 0 when the backup is another member's). */
  counts: Record<string, number>;
  /**
   * Replaces all progress on this device with the backup. Call only after the
   * person has confirmed. This device's home-server pairing and chat are kept.
   */
  apply(): Promise<void>;
}

/**
 * Reads and validates a backup file without changing anything. Throws BackupError
 * with a readable message when the file is not a usable Issho backup.
 */
export async function importBackup(file: Blob): Promise<BackupImport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new BackupError('This file is not an Issho backup (it is not valid JSON).');
  }
  const backup = parsed as Partial<BackupFile> | null;
  if (!backup || typeof backup !== 'object' || backup.format !== FORMAT) {
    throw new BackupError('This file is not an Issho backup.');
  }
  if (typeof backup.version !== 'number' || backup.version > VERSION) {
    throw new BackupError('This backup was made by a newer version of Issho. Update the app and try again.');
  }
  const exportedAt = new Date(backup.exportedAt ?? '');
  if (Number.isNaN(exportedAt.getTime()) || !backup.tables || typeof backup.tables !== 'object') {
    throw new BackupError('This backup is damaged (missing its contents).');
  }

  const known = new Set(db.tables.map((t) => t.name));
  const rowsByTable: Record<string, Row[]> = {};
  for (const [name, rule] of Object.entries(TABLE_RULES)) {
    if (!known.has(name)) continue;
    const raw = backup.tables[name];
    if (raw === undefined && !rule.required) {
      rowsByTable[name] = [];
      continue;
    }
    if (!Array.isArray(raw)) throw new BackupError(`This backup is damaged (the ${name} table is missing).`);
    const rows = raw.map((r) => decode(r)) as Row[];
    const bad = rows.findIndex((r) => !r || typeof r !== 'object' || !rule.valid(r));
    if (bad >= 0) throw new BackupError(`This backup is damaged (row ${bad + 1} of ${name} is not valid).`);
    rowsByTable[name] = rows;
  }
  const backupSettings = rowsByTable.settings ?? [];
  if (backupSettings.length > 1) {
    throw new BackupError('This backup is damaged (more than one settings row).');
  }
  const backupMemberId = backupSettings[0]?.memberId;
  const restoresChat = (s: Settings) => Boolean(s.deviceToken && s.memberId) && backupMemberId === s.memberId;

  const chatNow = restoresChat(await getSettings());
  const counts = Object.fromEntries(Object.entries(rowsByTable).map(
    ([name, rows]) => [name, CHAT_TABLES.has(name) && !chatNow ? 0 : rows.length],
  ));

  return {
    exportedAt,
    counts,
    async apply() {
      const current = await getSettings();
      const mergeChat = restoresChat(current);
      // Keep this device's pairing; an unpaired device stays unpaired (the backup
      // has no token, so its member details would be dangling).
      const pairing: Partial<Settings> = current.deviceToken
        ? { serverUrl: current.serverUrl, deviceToken: current.deviceToken, memberId: current.memberId, householdName: current.householdName }
        : { deviceToken: undefined, memberId: undefined, householdName: undefined };
      // A backup made before onboarding has no settings row; keep this device's.
      const settings = backupSettings.length ? backupSettings.map((s) => ({ ...s, ...pairing })) : [current];
      await db.transaction('rw', db.tables, async () => {
        for (const table of db.tables) {
          if (!CHAT_TABLES.has(table.name)) await table.clear();
        }
        for (const [name, rows] of Object.entries(rowsByTable)) {
          if (CHAT_TABLES.has(name) && !mergeChat) continue;
          const toWrite = name === 'settings' ? settings : rows;
          if (toWrite.length) await (db.table(name) as Table<Row>).bulkPut(toWrite);
        }
      });
    },
  };
}

/**
 * Asks the browser to keep this site's storage even under pressure (iOS evicts
 * data of sites not used for a while otherwise). Call once after onboarding.
 * Resolves true when storage is persistent.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return false;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
