import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dayKey, updateSettings } from '../lib/db.ts';
import { startSync } from './index.ts';
import { getServerStatus } from './socket.ts';
import { FakeSocket, installFakeSocket } from './testSocket.ts';

vi.mock('../srs/progress.ts', () => ({
  knownKanji: async () => ['一'],
  streak: async () => ({ current: 1, best: 1, todayDone: false, week: [] }),
  weekStats: async () => [],
}));
vi.mock('../srs/course.ts', () => ({ currentPhase: async () => 2 }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const requests: string[] = [];
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const path = new URL(String(input), 'http://app.test').pathname;
  requests.push(`${init?.method ?? 'GET'} ${path}`);
  if (path === '/api/messages') return json([]);
  if (path === '/api/household') return json({ householdName: 'Home', me: 'me', members: [], sharedStreak: 0 });
  return json({ ok: true });
});

let stop: (() => void) | undefined;

beforeEach(async () => {
  requests.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  installFakeSocket();
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

describe('startSync', () => {
  it('stays quiet while unpaired', async () => {
    stop = startSync();
    await vi.waitFor(() => expect(getServerStatus()).toBe('unpaired'));
    expect(FakeSocket.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connects and catches up when paired, and disconnects when unpaired', async () => {
    await updateSettings({ serverUrl: 'https://home.example', deviceToken: 'tok', memberId: 'me' });
    stop = startSync();

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(FakeSocket.latest().url).toBe('wss://home.example/api/ws?token=tok');
    await vi.waitFor(() => {
      expect(requests).toContain('GET /api/messages');
      expect(requests).toContain('GET /api/household');
      expect(requests).toContain('POST /api/stats');
    });

    await updateSettings({ deviceToken: undefined });
    await vi.waitFor(() => expect(getServerStatus()).toBe('unpaired'));
    expect(FakeSocket.latest().readyState).toBe(FakeSocket.CLOSED);
  });

  it('pairs live: connects as soon as a token is saved', async () => {
    stop = startSync();
    await vi.waitFor(() => expect(getServerStatus()).toBe('unpaired'));
    await updateSettings({ serverUrl: '', deviceToken: 'tok', memberId: 'me' });
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(FakeSocket.latest().url).toBe(`ws://${location.host}/api/ws?token=tok`);
  });

  it('shares stats right away when a session is completed', async () => {
    await updateSettings({ serverUrl: 'https://home.example', deviceToken: 'tok', memberId: 'me' });
    const today = dayKey();
    await db.days.put({ date: today, studyMs: 0, reviews: 3, correct: 3, newItems: 0, sessionComplete: false });
    stop = startSync();
    await vi.waitFor(() => expect(requests.filter((r) => r === 'POST /api/stats')).toHaveLength(1));

    await db.days.update(today, { sessionComplete: true });
    await vi.waitFor(() => expect(requests.filter((r) => r === 'POST /api/stats')).toHaveLength(2), { timeout: 2000 });
  });
});
