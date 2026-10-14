// Chat history: a local mirror of the server's messages (db.messages), kept up to
// date by catch-up syncs and live socket events, plus the outbox rows that have
// not been delivered yet.

import { useLiveQuery } from 'dexie-react-hooks';
import type { Table } from 'dexie';
import type { ChatMessage } from '../../shared/api.ts';
import { db, getSettings } from '../lib/db.ts';
import type { ChatMessageRecord } from '../lib/types.ts';
import { getMessages, isPairedSettings } from './client.ts';
import type { PendingMessage } from './outbox.ts';
import { onServerEvent, onStatusChange } from './socket.ts';

const PAGE_SIZE = 100;

export function toMessageRecord(m: ChatMessage): ChatMessageRecord {
  const rec: ChatMessageRecord = {
    id: m.id,
    clientId: m.clientId,
    memberId: m.memberId,
    createdAt: m.createdAt,
    kind: m.kind,
    text: m.text,
  };
  if (m.writtenAt !== undefined) rec.writtenAt = m.writtenAt;
  if (m.transcript !== undefined) rec.transcript = m.transcript;
  if (m.audioId !== undefined) rec.audioId = m.audioId;
  return rec;
}

/** Stores server messages and drops any outbox rows they confirm. */
export async function storeMessages(messages: ChatMessage[]): Promise<void> {
  if (!messages.length) return;
  await db.transaction('rw', db.messages, db.outbox, async () => {
    await db.messages.bulkPut(messages.map(toMessageRecord));
    await db.outbox.bulkDelete(messages.map((m) => m.clientId));
  });
}

/**
 * Stores one message that arrived outside a catch-up sync: a live socket event, or
 * the server's reply to one of our own sends. Server ids are sequential, so an id
 * more than one past the newest stored message means some were missed (the socket
 * was down or not yet connected). They are fetched in the background, because the
 * next catch-up starts after the newest stored id and would skip them for good.
 */
export async function storeLiveMessage(message: ChatMessage): Promise<void> {
  const newest = (await db.messages.orderBy('id').last())?.id ?? 0;
  await storeMessages([message]);
  if (message.id > newest + 1) {
    syncMessages(newest).catch((e) => console.warn('could not fetch missed chat messages', e));
  }
}

export interface ChatItem {
  /** Stable React key: the clientId, which survives the pending → sent transition. */
  key: string;
  /** Server id; absent while pending. */
  id?: number;
  clientId: string;
  memberId: string;
  /** When the server got it (orders the conversation); for a pending message, when it was written. */
  createdAt: string;
  /** When it was written on the sender's phone, if known. Show `writtenAt ?? createdAt`. */
  writtenAt?: string;
  kind: ChatMessageRecord['kind'];
  text: string;
  transcript?: string;
  audioId?: string;
  /** The local recording of a voice message that has not been delivered yet. */
  audio?: Blob;
  status: 'sent' | 'pending' | 'failed';
  /** Server error code when status is 'failed'. */
  error?: string;
  mine: boolean;
}

let syncing: Promise<number> | null = null;

/**
 * Fetches messages newer than `after` (default: the newest stored one) until caught up.
 * Resolves with how many were fetched. Concurrent calls share one run.
 */
export function syncMessages(after?: number): Promise<number> {
  if (syncing && after === undefined) return syncing;
  const run = (async () => {
    if (!isPairedSettings(await getSettings())) return 0;
    let cursor = after ?? (await db.messages.orderBy('id').last())?.id ?? 0;
    let total = 0;
    for (;;) {
      const page = await getMessages(cursor, PAGE_SIZE);
      await storeMessages(page);
      total += page.length;
      if (page.length < PAGE_SIZE) return total;
      cursor = Math.max(cursor, ...page.map((m) => m.id));
    }
  })();
  if (after === undefined) {
    syncing = run;
    void run.catch(() => {}).finally(() => { if (syncing === run) syncing = null; });
  }
  return run;
}

/** Live view of the conversation, oldest first; undefined while loading. */
export function useChatMessages(limit = 200): ChatItem[] | undefined {
  return useLiveQuery(async () => {
    const [settings, sent, pending] = await Promise.all([
      getSettings(),
      db.messages.orderBy('id').reverse().limit(limit).toArray(),
      (db.outbox as unknown as Table<PendingMessage, string>).orderBy('createdAt').toArray(),
    ]);
    const me = settings.memberId ?? '';
    const items: ChatItem[] = sent.reverse().map((m) => ({
      key: m.clientId,
      id: m.id,
      clientId: m.clientId,
      memberId: m.memberId,
      createdAt: m.createdAt,
      writtenAt: m.writtenAt,
      kind: m.kind,
      text: m.text,
      transcript: m.transcript,
      audioId: m.audioId,
      status: 'sent',
      mine: m.memberId === me,
    }));
    const delivered = new Set(sent.map((m) => m.clientId));
    for (const p of pending) {
      if (delivered.has(p.clientId)) continue;
      items.push({
        key: p.clientId,
        clientId: p.clientId,
        memberId: me,
        createdAt: p.createdAt.toISOString(),
        writtenAt: p.createdAt.toISOString(),
        kind: p.kind,
        text: p.text,
        transcript: p.transcript,
        audioId: p.audioId,
        audio: p.audio,
        status: p.failed ? 'failed' : 'pending',
        error: p.failed,
        mine: true,
      });
    }
    return items;
  }, [limit]);
}

/** Stores live 'message' events and catches up whenever the socket (re)connects. */
export function startChat(): () => void {
  const offEvents = onServerEvent((ev) => {
    if (ev.type !== 'message') return;
    storeLiveMessage(ev.message).catch((e) => console.warn('could not store chat message', e));
  });
  const offStatus = onStatusChange((s) => {
    if (s === 'online') syncMessages().catch(() => {});
  });
  return () => {
    offEvents();
    offStatus();
  };
}
