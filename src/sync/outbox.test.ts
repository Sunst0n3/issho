// @vitest-environment node
// Node's environment, because Dexie only treats the global Blob as a value to keep
// when update() copies a row. Under jsdom the global Blob is jsdom's, which
// fake-indexeddb cannot clone, so a stored recording would turn into {} on the
// first update; browsers have one Blob and do not have this problem.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SendMessageRequest } from '../../shared/api.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import { storeMessages } from './chat.ts';
import {
  discardMessage,
  flushOutbox,
  queueChatMessage,
  retryMessage,
  uuid,
  type PendingMessage,
} from './outbox.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A tiny fake home server: records requests and answers per route. */
function fakeServer() {
  let nextId = 1;
  const posts: SendMessageRequest[] = [];
  const uploads: string[] = [];
  /** Everything the server has stored, for GET /api/messages. */
  const history: ChatMessage[] = [];
  const routes = {
    message: (_req: SendMessageRequest): Response | Error | null => null,
    voice: (): Response | Error | null => null,
  };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/voice') {
      uploads.push(url.href);
      const override = routes.voice();
      if (override instanceof Error) throw override;
      return override ?? json({ audioId: `audio-${uploads.length}` });
    }
    if (url.pathname === '/api/messages' && init?.method === 'POST') {
      const req = JSON.parse(init.body as string) as SendMessageRequest;
      posts.push(req);
      const override = routes.message(req);
      if (override instanceof Error) throw override;
      if (override) return override;
      const msg: ChatMessage = { id: nextId++, memberId: 'me', createdAt: new Date().toISOString(), ...req };
      history.push(msg);
      return json(msg);
    }
    if (url.pathname === '/api/messages') {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      return json(history.filter((m) => m.id > after).slice(0, limit));
    }
    return json({ error: 'not_found' }, 404);
  });
  const partnerSends = (id: number, text: string) => {
    history.push({ id, clientId: `p${id}`, memberId: 'partner', createdAt: new Date().toISOString(), kind: 'text', text });
    nextId = id + 1;
  };
  return { fetchMock, posts, uploads, routes, history, partnerSends };
}

let server: ReturnType<typeof fakeServer>;

const audioBlob = (text = 'sound') => new Blob([text], { type: 'audio/mp4' });

beforeEach(async () => {
  await flushOutbox(); // let any run from a previous test settle
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'tok', memberId: 'me' });
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pendingRows = () => db.outbox.orderBy('createdAt').toArray() as Promise<PendingMessage[]>;

describe('queueChatMessage + flushOutbox', () => {
  it('delivers a text message and moves it into the message cache', async () => {
    const clientId = await queueChatMessage({ kind: 'text', text: 'ただいま' });
    const result = await flushOutbox();

    expect(server.posts).toEqual([{ clientId, kind: 'text', text: 'ただいま' }]);
    expect(result).toMatchObject({ remaining: 0, blocked: false });
    expect(await db.outbox.count()).toBe(0);
    const stored = await db.messages.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ clientId, text: 'ただいま', kind: 'text', memberId: 'me' });
  });

  it('uploads voice audio first, then sends the message with its audioId', async () => {
    const clientId = await queueChatMessage({ kind: 'voice', text: '', transcript: 'おかえり', audio: audioBlob() });
    await flushOutbox();

    expect(server.uploads).toHaveLength(1);
    expect(server.posts).toEqual([{ clientId, kind: 'voice', text: '', transcript: 'おかえり', audioId: 'audio-1' }]);
    expect(server.fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      'http://home:8787/api/voice',
      'http://home:8787/api/messages',
    ]);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects a voice message without audio', async () => {
    await expect(queueChatMessage({ kind: 'voice', text: '' })).rejects.toThrow();
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps messages queued, in order, while the server is unreachable', async () => {
    server.routes.message = () => new TypeError('Failed to fetch');
    const first = await queueChatMessage({ kind: 'text', text: '一' });
    const second = await queueChatMessage({ kind: 'text', text: '二' });
    const result = await flushOutbox();

    expect(result).toMatchObject({ sent: 0, remaining: 2, blocked: true });
    // It stops at the first failure rather than sending the second message out of order.
    expect(server.posts.every((p) => p.clientId === first)).toBe(true);
    const rows = await pendingRows();
    expect(rows.map((r) => r.clientId)).toEqual([first, second]);
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
    expect(rows[0].failed).toBeUndefined();

    server.routes.message = () => null;
    await flushOutbox();
    expect(server.posts.slice(-2).map((p) => p.clientId)).toEqual([first, second]);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.messages.orderBy('id').toArray()).map((m) => m.text)).toEqual(['一', '二']);
  });

  it('does not upload the same recording twice when only the message failed', async () => {
    server.routes.message = () => json({ error: 'unavailable' }, 503);
    await queueChatMessage({ kind: 'voice', text: '', audio: audioBlob() });
    await flushOutbox();

    const [row] = await pendingRows();
    expect(row.audioId).toBe('audio-1');
    expect(server.uploads).toHaveLength(1);

    server.routes.message = () => null;
    await flushOutbox();
    expect(server.uploads).toHaveLength(1);
    expect(server.posts.at(-1)).toMatchObject({ audioId: 'audio-1' });
    expect(await db.outbox.count()).toBe(0);
  });

  it('marks a message the server rejects as failed and carries on with the rest', async () => {
    server.routes.message = (req) => (req.text === 'bad' ? json({ error: 'too_long' }, 400) : null);
    const bad = await queueChatMessage({ kind: 'text', text: 'bad' });
    await queueChatMessage({ kind: 'text', text: 'good' });
    const result = await flushOutbox();

    expect(result).toMatchObject({ remaining: 0, blocked: false });
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: bad, failed: 'too_long' });
    expect((await db.messages.toArray()).map((m) => m.text)).toEqual(['good']);

    // Failed rows are not retried automatically...
    const before = server.posts.length;
    await flushOutbox();
    expect(server.posts.length).toBe(before);

    // ...only on request.
    server.routes.message = () => null;
    await retryMessage(bad);
    await flushOutbox();
    expect(await db.outbox.count()).toBe(0);
  });

  it('uploads the recording again on retry when the server no longer has the earlier upload', async () => {
    server.routes.message = (req) => (req.audioId === 'audio-1' ? json({ error: 'unknown_audio' }, 400) : null);
    const clientId = await queueChatMessage({ kind: 'voice', text: '', audio: audioBlob() });
    await flushOutbox();
    const [row] = await pendingRows();
    expect(row).toMatchObject({ clientId, failed: 'unknown_audio' });
    expect(row.audioId).toBeUndefined();

    await retryMessage(clientId);
    await flushOutbox();
    expect(server.uploads).toHaveLength(2);
    expect(server.posts.at(-1)).toMatchObject({ clientId, audioId: 'audio-2' });
    expect(await db.outbox.count()).toBe(0);
  });

  it('fetches messages it missed when its own send comes back with a later id', async () => {
    // The socket was down: the partner's messages 2 and 3 never arrived live.
    server.partnerSends(1, 'one');
    await db.messages.put({ ...server.history[0] });
    server.partnerSends(2, 'two');
    server.partnerSends(3, 'three');

    await queueChatMessage({ kind: 'text', text: 'four' });
    await flushOutbox();

    // Without a backfill the next catch-up would start after 4 and skip 2 and 3 for good.
    await vi.waitFor(async () => {
      expect((await db.messages.orderBy('id').toArray()).map((m) => m.text)).toEqual(['one', 'two', 'three', 'four']);
    });
  });

  it('keeps a message for after pairing again when the server no longer accepts this phone', async () => {
    server.routes.message = () => json({ error: 'unauthorized' }, 401);
    await queueChatMessage({ kind: 'text', text: 'hi' });
    const result = await flushOutbox();
    expect(result.blocked).toBe(true);
    expect((await pendingRows())[0].failed).toBeUndefined();
    // The pairing is forgotten, so later flushes wait without calling the server.
    expect((await getSettings()).deviceToken).toBeUndefined();
    server.fetchMock.mockClear();
    expect(await flushOutbox()).toEqual({ sent: 0, remaining: 1, blocked: true });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing while unpaired', async () => {
    await updateSettings({ deviceToken: undefined });
    await queueChatMessage({ kind: 'text', text: 'later' });
    const result = await flushOutbox();
    expect(result).toEqual({ sent: 0, remaining: 1, blocked: true });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('shares one run between concurrent flushes', async () => {
    await updateSettings({ deviceToken: undefined });
    await queueChatMessage({ kind: 'text', text: 'a' });
    await queueChatMessage({ kind: 'text', text: 'b' });
    await updateSettings({ deviceToken: 'tok' });

    await Promise.all([flushOutbox(), flushOutbox(), flushOutbox()]);
    expect(server.posts.map((p) => p.text)).toEqual(['a', 'b']);
  });

  it('can discard an undelivered message', async () => {
    await updateSettings({ deviceToken: undefined });
    const id = await queueChatMessage({ kind: 'text', text: 'oops' });
    await discardMessage(id);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('storeMessages', () => {
  it('drops outbox rows the server has confirmed (e.g. via a socket echo)', async () => {
    await updateSettings({ deviceToken: undefined });
    const clientId = await queueChatMessage({ kind: 'text', text: 'echo' });
    await storeMessages([{ id: 5, clientId, memberId: 'me', createdAt: '2026-10-14T00:00:00Z', kind: 'text', text: 'echo' }]);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.messages.get(5)).toMatchObject({ clientId });
  });
});

describe('uuid', () => {
  it('produces RFC 4122 v4 ids even without crypto.randomUUID', () => {
    const original = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
      const id = uuid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(uuid()).not.toBe(id);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
