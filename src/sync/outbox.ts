// Offline-first chat sending. Every message is written to db.outbox first, then
// delivered in order: voice audio is uploaded, then the message is POSTed with
// its clientId (the server dedupes on it, so a retry after a lost response is
// safe) and the time it was written. Delivered messages move into db.messages.
// Rows are only ever removed once delivered or discarded by the user: unpairing
// and pairing again keep them (see pair()).
//
// Flushes run on demand, when the browser comes online, when the socket connects,
// and every 30 s while undelivered rows remain.

import type { Table } from 'dexie';
import { db, getSettings } from '../lib/db.ts';
import type { OutboxRecord } from '../lib/types.ts';
import { storeLiveMessage } from './chat.ts';
import { ApiError, isPairedSettings, OTHER_HOUSEHOLD, sendMessage, uploadVoice } from './client.ts';
import { onStatusChange } from './socket.ts';
import { rememberVoice } from './voice.ts';

/** Outbox rows as stored. Extends the shared OutboxRecord with delivery bookkeeping. */
export interface PendingMessage extends OutboxRecord {
  /** Set once the voice clip is uploaded, so a retry doesn't upload it twice. */
  audioId?: string;
  /** Server error code when the message was rejected for good; not retried automatically. */
  failed?: string;
}

export interface NewChatMessage {
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audio?: Blob;
  /** 'daily' = the output step's sentence of the day (or the partner's reply to it). */
  tag?: 'daily';
}

export interface FlushResult {
  sent: number;
  /** Undelivered rows still waiting, not counting failed ones (-1 if unknown after an unexpected error). */
  remaining: number;
  /** Stopped early: unpaired, or the server could not be reached. */
  blocked: boolean;
}

export const RETRY_INTERVAL_MS = 30_000;

const outbox = () => db.outbox as unknown as Table<PendingMessage, string>;

/** crypto.randomUUID only exists in secure contexts; a LAN server may be plain http. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let lastQueuedAt = 0;

/** Saves a message for sending and starts delivery. Resolves with its clientId once saved locally. */
export async function queueChatMessage(msg: NewChatMessage): Promise<string> {
  if (msg.kind === 'voice' && !msg.audio) throw new Error('A voice message needs its audio.');
  // Rows are delivered in createdAt order, so two messages queued in the same
  // millisecond must still get distinct, increasing timestamps.
  lastQueuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  const row: PendingMessage = {
    clientId: uuid(),
    createdAt: new Date(lastQueuedAt),
    kind: msg.kind,
    text: msg.text,
    attempts: 0,
  };
  // The household it is written for: the one this phone is (or was last) paired with.
  const householdId = (await getSettings()).lastPairing?.householdId;
  if (householdId) row.householdId = householdId;
  if (msg.transcript !== undefined) row.transcript = msg.transcript;
  if (msg.audio) row.audio = msg.audio;
  if (msg.tag) row.tag = msg.tag;
  await outbox().add(row);
  void flushOutbox();
  return row.clientId;
}

/**
 * Re-queues a message the server rejected earlier, or one written for another household:
 * resending that one here is the user's choice, so it now belongs to this phone's household.
 */
export async function retryMessage(clientId: string): Promise<void> {
  const household = (await getSettings()).lastPairing?.householdId;
  const row = await outbox().get(clientId);
  if (!row) return;
  const moved = row.failed === OTHER_HOUSEHOLD && household ? { householdId: household } : {};
  await outbox().update(clientId, { failed: undefined, attempts: 0, ...moved });
  void flushOutbox();
}

/** Removes an undelivered message. */
export async function discardMessage(clientId: string): Promise<void> {
  await outbox().delete(clientId);
}

async function countWaiting(): Promise<number> {
  return outbox().filter((r) => !r.failed).count();
}

async function flushOnce(): Promise<FlushResult> {
  const settings = await getSettings();
  if (!isPairedSettings(settings)) return { sent: 0, remaining: await countWaiting(), blocked: true };
  const household = settings.lastPairing?.householdId;

  const rows = await outbox().orderBy('createdAt').toArray();
  let sent = 0;
  for (const row of rows) {
    if (row.failed) continue;
    if (household && row.householdId && row.householdId !== household) {
      // Written for another household (pair() normally marks these): never send it here unasked.
      await outbox().update(row.clientId, { failed: OTHER_HOUSEHOLD });
      continue;
    }
    try {
      let audioId = row.audioId;
      if (row.kind === 'voice' && !audioId) {
        if (!row.audio) {
          await outbox().update(row.clientId, { failed: 'missing_audio' });
          continue;
        }
        audioId = (await uploadVoice(row.audio)).audioId;
        await outbox().update(row.clientId, { audioId });
      }
      const message = await sendMessage({
        clientId: row.clientId,
        writtenAt: new Date(row.createdAt).toISOString(),
        kind: row.kind,
        text: row.text,
        ...(row.transcript !== undefined ? { transcript: row.transcript } : {}),
        ...(audioId ? { audioId } : {}),
        ...(row.tag ? { tag: row.tag } : {}),
      });
      // The outbox row (and its recording) goes away now; keep the audio for playback.
      if (audioId && row.audio) rememberVoice(audioId, row.audio);
      await storeLiveMessage(message);
      sent++;
    } catch (e) {
      const permanent = e instanceof ApiError && !e.transient
        && e.status !== 401 && e.status !== 403 && e.code !== 'unpaired';
      await outbox().update(row.clientId, {
        attempts: row.attempts + 1,
        ...(permanent ? { failed: (e as ApiError).code } : {}),
        // The server no longer has the clip uploaded earlier (e.g. its data was reset):
        // forget that upload so a retry sends the recording again.
        ...(e instanceof ApiError && e.code === 'unknown_audio' ? { audioId: undefined } : {}),
      });
      // A rejected message is skipped; anything else means the server is unreachable
      // or unhappy, so stop here and keep the remaining messages in order.
      if (permanent) continue;
      return { sent, remaining: await countWaiting(), blocked: true };
    }
  }
  return { sent, remaining: await countWaiting(), blocked: false };
}

let running: Promise<FlushResult> | null = null;
let rerun = false;
let loopActive = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Delivers waiting messages in order. Concurrent calls share one run; a call made
 * while a run is in progress makes it go round once more to pick up new rows.
 */
export function flushOutbox(): Promise<FlushResult> {
  if (running) {
    rerun = true;
    return running;
  }
  rerun = false;
  running = flushOnce()
    .catch((e): FlushResult => {
      console.error('outbox flush failed', e);
      return { sent: 0, remaining: -1, blocked: true };
    })
    .then((result) => {
      running = null;
      if (rerun && !result.blocked) return flushOutbox();
      scheduleRetry(result.remaining !== 0);
      return result;
    });
  return running;
}

function scheduleRetry(pending: boolean) {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (loopActive && pending) retryTimer = setTimeout(() => void flushOutbox(), RETRY_INTERVAL_MS);
}

/** Starts the background delivery triggers. Returns a stop function. */
export function startOutbox(): () => void {
  if (loopActive) return () => {};
  loopActive = true;
  const onOnline = () => void flushOutbox();
  window.addEventListener('online', onOnline);
  const offStatus = onStatusChange((s) => { if (s === 'online') void flushOutbox(); });
  void flushOutbox();
  return () => {
    loopActive = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    window.removeEventListener('online', onOnline);
    offStatus();
  };
}
