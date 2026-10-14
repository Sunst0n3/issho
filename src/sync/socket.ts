// One WebSocket to the home server for live events (chat, stats, quizzes,
// presence, role-play). Reconnects with exponential backoff; reconnects at once
// when the network comes back or the app returns to the foreground, because iOS
// silently kills sockets of backgrounded PWAs and leaves them looking open.

import { useSyncExternalStore } from 'react';
import type { ClientEvent, ServerEvent } from '../../shared/api.ts';
import { getSettings } from '../lib/db.ts';
import { socketUrl } from './client.ts';

export type ServerStatus = 'unpaired' | 'offline' | 'connecting' | 'online';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Keeps NAT and proxy idle timeouts from dropping a quiet connection. */
const PING_INTERVAL_MS = 25_000;
/** After this long in the background, assume the socket is dead even if it claims to be open. */
const HIDDEN_STALE_MS = 15_000;

type Listener<T> = (value: T) => void;

let target: string | null = null;
let ws: WebSocket | null = null;
// Starts as 'connecting' so screens don't flash "not paired" before settings load.
let status: ServerStatus = 'connecting';
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let hiddenAt: number | null = null;
let removeLifecycle: (() => void) | null = null;

const eventListeners = new Set<Listener<ServerEvent>>();
const statusListeners = new Set<Listener<ServerStatus>>();

function setStatus(next: ServerStatus) {
  if (next === status) return;
  status = next;
  for (const cb of [...statusListeners]) {
    try { cb(next); } catch (e) { console.error('server status listener failed', e); }
  }
}

function dispatch(ev: ServerEvent) {
  for (const cb of [...eventListeners]) {
    try { cb(ev); } catch (e) { console.error('server event listener failed', e); }
  }
}

function parseEvent(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const ev = JSON.parse(data) as unknown;
    if (ev && typeof ev === 'object' && typeof (ev as { type?: unknown }).type === 'string') return ev as ServerEvent;
  } catch { /* ignore malformed frames */ }
  return null;
}

function dropSocket() {
  clearInterval(pingTimer);
  pingTimer = undefined;
  const sock = ws;
  ws = null;
  if (!sock) return;
  sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
  try { sock.close(); } catch { /* already closed */ }
}

function open() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (!target) { setStatus('unpaired'); return; }
  // While the browser knows it is offline, wait for the 'online' event instead of spinning.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('offline'); return; }

  setStatus('connecting');
  let sock: WebSocket;
  try {
    sock = new WebSocket(target);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    attempt = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sendClientEvent({ type: 'ping' }), PING_INTERVAL_MS);
    setStatus('online');
  };
  sock.onmessage = (msg) => {
    const ev = parseEvent(msg.data);
    if (ev) dispatch(ev);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    dropSocket();
    scheduleReconnect();
  };
  // 'close' always follows 'error', and reconnecting is handled there.
  sock.onerror = () => {};
}

function scheduleReconnect() {
  if (!target) { setStatus('unpaired'); return; }
  setStatus('offline');
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
  attempt++;
  // Jitter so two phones don't hammer the server in lockstep after it restarts.
  const delay = base / 2 + Math.random() * (base / 2);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(open, delay);
}

/** Opens a fresh connection now, unless one is already open (or `force`). */
export function reconnectNow(force = false) {
  if (!target) return;
  if (!force && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  attempt = 0;
  dropSocket();
  open();
}

function installLifecycle() {
  if (removeLifecycle || typeof window === 'undefined') return;
  const onOnline = () => reconnectNow();
  const onOffline = () => {
    // The socket usually lingers as "open" for a while; drop it so status is honest.
    if (!target) return;
    dropSocket();
    clearTimeout(retryTimer);
    setStatus('offline');
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const wasHiddenLong = hiddenAt !== null && Date.now() - hiddenAt > HIDDEN_STALE_MS;
    hiddenAt = null;
    reconnectNow(wasHiddenLong);
  };
  const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) reconnectNow(true); };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);
  removeLifecycle = () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibility);
    removeLifecycle = null;
  };
}

/** Connects to `url`, or disconnects when it is null (unpaired). No-op if already on that URL. */
export function connectSocket(url: string | null) {
  if (!url) { disconnectSocket(); return; }
  if (url === target && (ws || retryTimer !== undefined)) return;
  target = url;
  dropSocket();
  attempt = 0;
  installLifecycle();
  open();
}

/** Connects using the server address and token in settings (disconnects when unpaired). */
export async function connectFromSettings(): Promise<void> {
  connectSocket(socketUrl(await getSettings()));
}

/** Closes the socket and stops reconnecting. */
export function disconnectSocket() {
  target = null;
  dropSocket();
  clearTimeout(retryTimer);
  retryTimer = undefined;
  removeLifecycle?.();
  setStatus('unpaired');
}

/** Sends an event if the socket is open. Returns false when it could not be sent. */
export function sendClientEvent(ev: ClientEvent): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(ev));
    return true;
  } catch {
    return false;
  }
}

export function onServerEvent(cb: Listener<ServerEvent>): () => void {
  eventListeners.add(cb);
  return () => { eventListeners.delete(cb); };
}

export function onStatusChange(cb: Listener<ServerStatus>): () => void {
  statusListeners.add(cb);
  return () => { statusListeners.delete(cb); };
}

export function getServerStatus(): ServerStatus {
  return status;
}

function subscribeStatus(onChange: () => void) {
  return onStatusChange(onChange);
}

export function useServerStatus(): ServerStatus {
  return useSyncExternalStore(subscribeStatus, getServerStatus, getServerStatus);
}
