import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdResponse, StatsUploadRequest } from '../../shared/api.ts';
import { db, updateSettings } from '../lib/db.ts';
import { connectSocket, disconnectSocket } from './socket.ts';
import { flushPendingStats, pushStats, refreshHousehold, resetHousehold, startHousehold, useHousehold } from './stats.ts';
import { FakeSocket, installFakeSocket } from './testSocket.ts';

vi.mock('../srs/progress.ts', () => ({
  knownKanji: async () => ['一', '二', '三'],
  streak: async () => ({ current: 6, best: 9, todayDone: true, week: [] }),
  weekStats: async () => [
    { date: '2026-10-13', studyMs: 600_000, reviews: 50, correct: 45, newItems: 4, sessionComplete: true },
    { date: '2026-10-14', studyMs: 120_000, reviews: 10, correct: 9, newItems: 0, sessionComplete: false },
  ],
}));
vi.mock('../srs/course.ts', () => ({ currentPhase: async () => 2 }));

const household: HouseholdResponse = {
  householdName: 'Our home',
  me: 'me',
  members: [],
  sharedStreak: 3,
};

/** Fakes timeouts only: fake-indexeddb runs on setImmediate, which must stay real or Dexie stalls. */
const useTimerFakes = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let uploads: StatsUploadRequest[];
let householdGets: number;
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input);
  if (url.endsWith('/api/stats')) {
    uploads.push(JSON.parse(init!.body as string));
    return json({ ok: true });
  }
  if (url.endsWith('/api/household')) {
    householdGets++;
    return json(household);
  }
  return json({ error: 'not_found' }, 404);
});

/** In-memory Storage: Node's own experimental localStorage shadows jsdom's and is unusable here. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  uploads = [];
  householdGets = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  installFakeSocket();
  resetHousehold();
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'tok', memberId: 'me' });
});

afterEach(() => {
  disconnectSocket();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pushStats', () => {
  it('uploads the last days, streak, kanji and phase', async () => {
    await expect(pushStats({ immediate: true })).resolves.toBe(true);
    expect(uploads).toEqual([{
      days: [
        { date: '2026-10-13', studyMinutes: 10, reviews: 50, correct: 45, newItems: 4, sessionComplete: true },
        { date: '2026-10-14', studyMinutes: 2, reviews: 10, correct: 9, newItems: 0, sessionComplete: false },
      ],
      streak: 6,
      kanjiKnown: 3,
      knownKanji: ['一', '二', '三'],
      phase: 2,
    }]);
  });

  it('debounces a burst of calls into one upload', async () => {
    useTimerFakes();
    const results = [pushStats(), pushStats(), pushStats()];
    await vi.advanceTimersByTimeAsync(14_000);
    expect(uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all(results)).resolves.toEqual([true, true, true]);
    expect(uploads).toHaveLength(1);
  });

  it('does not let a debounced call postpone an immediate one', async () => {
    useTimerFakes();
    const first = pushStats({ immediate: true });
    const second = pushStats();
    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(uploads).toHaveLength(1);
  });

  it('flushPendingStats() sends a waiting upload now', async () => {
    useTimerFakes();
    const pending = pushStats();
    flushPendingStats();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it('resolves false without a request when unpaired', async () => {
    await updateSettings({ deviceToken: undefined });
    await expect(pushStats({ immediate: true })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves false when the server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(pushStats({ immediate: true })).resolves.toBe(false);
  });
});

describe('household', () => {
  it('fetches on first use and caches the result for offline launches', async () => {
    const { result } = renderHook(() => useHousehold());
    await waitFor(() => expect(result.current.data).toEqual(household));
    expect(result.current.loading).toBe(false);
    expect(JSON.parse(localStorage.getItem('issho.household.v1')!).data).toEqual(household);
  });

  it('keeps showing the last data when a refresh fails', async () => {
    await refreshHousehold();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await refreshHousehold();
    const { result } = renderHook(() => useHousehold());
    expect(result.current.data).toEqual(household);
    expect(result.current.error).toMatchObject({ code: 'network' });
  });

  it('refreshes when the partner uploads new stats', async () => {
    const stop = startHousehold();
    connectSocket('ws://home:8787/api/ws?token=tok');
    act(() => FakeSocket.latest().accept());
    await waitFor(() => expect(householdGets).toBe(1));

    act(() => FakeSocket.latest().receive({ type: 'stats', memberId: 'partner' }));
    await waitFor(() => expect(householdGets).toBe(2));
    stop();
  });

  it('clears the cached view when unpaired', async () => {
    await refreshHousehold();
    await updateSettings({ deviceToken: undefined });
    await refreshHousehold();
    const { result } = renderHook(() => useHousehold());
    expect(result.current.data).toBeUndefined();
    expect(localStorage.getItem('issho.household.v1')).toBeNull();
  });
});
