import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/api.ts';
import { db, updateSettings } from '../lib/db.ts';
import { startChat, syncMessages, useChatMessages } from './chat.ts';
import type { PendingMessage } from './outbox.ts';
import { connectSocket, disconnectSocket } from './socket.ts';
import { FakeSocket, installFakeSocket } from './testSocket.ts';

const msg = (id: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  clientId: `c${id}`,
  memberId: id % 2 ? 'partner' : 'me',
  createdAt: new Date(Date.UTC(2026, 9, 14, 0, id)).toISOString(),
  kind: 'text',
  text: `message ${id}`,
  ...patch,
});

/** Server history 1..n; GET /api/messages honours after/limit. */
function serveHistory(n: number) {
  const history = Array.from({ length: n }, (_, i) => msg(i + 1));
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'http://app.test');
    const after = Number(url.searchParams.get('after'));
    const limit = Number(url.searchParams.get('limit'));
    const page = history.filter((m) => m.id > after).slice(0, limit);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { history, fetchMock, afters: () => fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://app.test').searchParams.get('after')) };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'tok', memberId: 'me' });
});

afterEach(() => {
  disconnectSocket();
  vi.unstubAllGlobals();
});

describe('syncMessages', () => {
  it('pages through history until caught up', async () => {
    const server = serveHistory(230);
    await expect(syncMessages()).resolves.toBe(230);
    expect(server.afters()).toEqual(['0', '100', '200']);
    expect(await db.messages.count()).toBe(230);
  });

  it('continues after the newest stored message', async () => {
    const server = serveHistory(12);
    await db.messages.bulkPut(server.history.slice(0, 10));
    await expect(syncMessages()).resolves.toBe(2);
    expect(server.afters()).toEqual(['10']);
  });

  it('does nothing while unpaired', async () => {
    const server = serveHistory(3);
    await updateSettings({ deviceToken: undefined });
    await expect(syncMessages()).resolves.toBe(0);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent calls', async () => {
    const server = serveHistory(3);
    await Promise.all([syncMessages(), syncMessages()]);
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('startChat', () => {
  beforeEach(() => installFakeSocket());

  it('stores live messages and backfills any it missed', async () => {
    const server = serveHistory(5);
    await db.messages.put(server.history[0]);
    const stop = startChat();
    connectSocket('ws://home:8787/api/ws?token=tok');
    FakeSocket.latest().accept(); // triggers a catch-up sync
    await waitFor(async () => expect(await db.messages.count()).toBe(5));

    // A live message whose id skips ahead means some were missed; they get fetched.
    server.history.push(msg(6), msg(7));
    FakeSocket.latest().receive({ type: 'message', message: msg(7) });
    await waitFor(async () => expect(await db.messages.count()).toBe(7));
    expect(server.afters().at(-1)).toBe('5');
    stop();
  });
});

describe('useChatMessages', () => {
  it('lists delivered messages oldest first, then pending and failed ones', async () => {
    await db.messages.bulkPut([msg(2), msg(1)]);
    const outbox = db.outbox as unknown as { bulkPut(rows: PendingMessage[]): Promise<unknown> };
    await outbox.bulkPut([
      { clientId: 'p2', createdAt: new Date('2026-10-14T01:00:00Z'), kind: 'text', text: 'second pending', attempts: 1, failed: 'too_long' },
      { clientId: 'p1', createdAt: new Date('2026-10-14T00:59:00Z'), kind: 'text', text: 'first pending', attempts: 0 },
      // Already delivered (stored above as message 1) but not yet removed from the outbox.
      { clientId: 'c1', createdAt: new Date('2026-10-14T00:01:00Z'), kind: 'text', text: 'message 1', attempts: 0 },
    ]);

    const { result } = renderHook(() => useChatMessages());
    await waitFor(() => expect(result.current).toBeDefined());
    const items = result.current!;

    expect(items.map((i) => i.key)).toEqual(['c1', 'c2', 'p1', 'p2']);
    expect(items.map((i) => i.status)).toEqual(['sent', 'sent', 'pending', 'failed']);
    expect(items.map((i) => i.mine)).toEqual([false, true, true, true]);
    expect(items[3].error).toBe('too_long');
    expect(items[2]).toMatchObject({ memberId: 'me', createdAt: '2026-10-14T00:59:00.000Z' });
  });

  it('passes on when each message was written', async () => {
    await db.messages.put({ ...msg(1), writtenAt: '2026-10-13T21:30:00.000Z' });
    await db.messages.put(msg(2));
    await (db.outbox as unknown as { put(row: PendingMessage): Promise<unknown> }).put(
      { clientId: 'p1', createdAt: new Date('2026-10-14T01:00:00Z'), kind: 'text', text: 'later', attempts: 0 },
    );
    const { result } = renderHook(() => useChatMessages());
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current!.map((i) => i.writtenAt)).toEqual(['2026-10-13T21:30:00.000Z', undefined, '2026-10-14T01:00:00.000Z']);
  });

  it('keeps writtenAt from the server in the cache', async () => {
    serveHistory(0).history.push({ ...msg(1), writtenAt: '2026-10-13T21:30:00.000Z' });
    await syncMessages();
    expect((await db.messages.get(1))?.writtenAt).toBe('2026-10-13T21:30:00.000Z');
  });

  it('updates live when a message arrives', async () => {
    const { result } = renderHook(() => useChatMessages());
    await waitFor(() => expect(result.current).toEqual([]));
    await db.messages.put(msg(1));
    await waitFor(() => expect(result.current).toHaveLength(1));
  });
});
