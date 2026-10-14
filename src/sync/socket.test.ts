import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../shared/api.ts';
import {
  connectSocket,
  disconnectSocket,
  getServerStatus,
  onServerEvent,
  sendClientEvent,
  useServerStatus,
} from './socket.ts';
import { FakeSocket, installFakeSocket } from './testSocket.ts';

const URL_A = 'ws://home:8787/api/ws?token=t';

let online = true;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeSocket();
  online = true;
  Object.defineProperty(navigator, 'onLine', { get: () => online, configurable: true });
  // No jitter: each retry waits exactly the backoff base.
  vi.spyOn(Math, 'random').mockReturnValue(1);
});

afterEach(() => {
  disconnectSocket();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection', () => {
  it('connects and reports its status', () => {
    connectSocket(URL_A);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.latest().url).toBe(URL_A);
    expect(getServerStatus()).toBe('connecting');
    FakeSocket.latest().accept();
    expect(getServerStatus()).toBe('online');
  });

  it('does not open a second socket for the same address', () => {
    connectSocket(URL_A);
    connectSocket(URL_A);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects to a new address when the pairing changes', () => {
    connectSocket(URL_A);
    FakeSocket.latest().accept();
    connectSocket('ws://other/api/ws?token=u');
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED);
  });

  it('is unpaired without an address', () => {
    connectSocket(null);
    expect(getServerStatus()).toBe('unpaired');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('exposes the status to React', () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => connectSocket(URL_A));
    expect(result.current).toBe('connecting');
    act(() => FakeSocket.latest().accept());
    expect(result.current).toBe('online');
    act(() => disconnectSocket());
    expect(result.current).toBe('unpaired');
  });
});

describe('reconnecting', () => {
  it('backs off exponentially and resets after a successful connection', () => {
    connectSocket(URL_A);
    FakeSocket.latest().drop();
    expect(getServerStatus()).toBe('offline');

    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.latest().drop();
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    FakeSocket.latest().drop();
    vi.advanceTimersByTime(4_000);
    expect(FakeSocket.instances).toHaveLength(4);

    FakeSocket.latest().accept();
    FakeSocket.latest().drop();
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it('caps the backoff at 30 seconds', () => {
    connectSocket(URL_A);
    for (let i = 0; i < 8; i++) {
      FakeSocket.latest().drop();
      vi.advanceTimersByTime(30_000);
    }
    const count = FakeSocket.instances.length;
    expect(count).toBe(9);
    FakeSocket.latest().drop();
    vi.advanceTimersByTime(29_999);
    expect(FakeSocket.instances).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(count + 1);
  });

  it('stops reconnecting after disconnectSocket()', () => {
    connectSocket(URL_A);
    FakeSocket.latest().drop();
    disconnectSocket();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(getServerStatus()).toBe('unpaired');
  });

  it('waits for the network instead of retrying while offline, then reconnects at once', () => {
    connectSocket(URL_A);
    FakeSocket.latest().accept();

    online = false;
    window.dispatchEvent(new Event('offline'));
    expect(getServerStatus()).toBe('offline');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);

    online = true;
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(getServerStatus()).toBe('connecting');
  });

  it('skips the backoff wait when the app returns to the foreground', () => {
    connectSocket(URL_A);
    FakeSocket.latest().drop(); // a retry is now scheduled 1 s out
    setVisibility('hidden');
    setVisibility('visible');
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('replaces a socket that sat in the background, even if it still looks open', () => {
    connectSocket(URL_A);
    FakeSocket.latest().accept();
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    setVisibility('visible');
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].readyState).toBe(FakeSocket.CLOSED);
  });

  it('keeps a socket that was only briefly in the background', () => {
    connectSocket(URL_A);
    FakeSocket.latest().accept();
    setVisibility('hidden');
    vi.advanceTimersByTime(3_000);
    setVisibility('visible');
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('events', () => {
  it('delivers server events to subscribers and ignores malformed frames', () => {
    const seen: ServerEvent[] = [];
    const off = onServerEvent((ev) => seen.push(ev));
    connectSocket(URL_A);
    const sock = FakeSocket.latest();
    sock.accept();

    sock.receive({ type: 'stats', memberId: 'm2' });
    sock.receive('not json');
    sock.receive({ nope: true });
    expect(seen).toEqual([{ type: 'stats', memberId: 'm2' }]);

    off();
    sock.receive({ type: 'stats', memberId: 'm2' });
    expect(seen).toHaveLength(1);
  });

  it('keeps delivering when one subscriber throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const offA = onServerEvent(() => { throw new Error('boom'); });
    const offB = onServerEvent((ev) => seen.push(ev.type));
    connectSocket(URL_A);
    FakeSocket.latest().accept();
    FakeSocket.latest().receive({ type: 'presence', memberId: 'm2', online: true });
    expect(seen).toEqual(['presence']);
    expect(errors).toHaveBeenCalled();
    offA();
    offB();
  });

  it('sends client events only while open', () => {
    connectSocket(URL_A);
    expect(sendClientEvent({ type: 'ping' })).toBe(false);
    FakeSocket.latest().accept();
    expect(sendClientEvent({ type: 'ping' })).toBe(true);
    expect(FakeSocket.latest().sent).toEqual(['{"type":"ping"}']);
  });

  it('pings periodically to keep the connection alive', () => {
    connectSocket(URL_A);
    FakeSocket.latest().accept();
    vi.advanceTimersByTime(25_000 * 2);
    expect(FakeSocket.latest().sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
  });
});
