// The real home server, in process, for the app's integration tests (TECH-DESIGN §5.2). The app's
// own WebSocket reaches it over 127.0.0.1 and its fetch calls are handed to the server's `inject`
// (Node's fetch rejects the jsdom AbortSignal the client passes); a test plays the partner's phone
// through `inject` (HTTP) and `socket` (a second WebSocket). Test-only: nothing in the app imports it.

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RegisterResponse, ServerEvent } from '../../shared/api.ts';
import { buildApp } from '../../server/src/app.ts';
import { loadConfig } from '../../server/src/config.ts';
import { Store } from '../../server/src/db.ts';

const HOUSEHOLD_CODE = 'integration household';

export interface InjectResult {
  statusCode: number;
  json<T>(): T;
}

export interface LiveServer {
  /** 'http://127.0.0.1:<port>', for Settings.serverUrl. */
  url: string;
  register(name: string): Promise<RegisterResponse>;
  /** An HTTP request as `token`'s device, without going through the app's client. */
  inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown): Promise<InjectResult>;
  /** A partner phone's socket: every server event it receives, and a way to send client events. */
  socket(token: string): Promise<PartnerSocket>;
  close(): Promise<void>;
}

export interface PartnerSocket {
  events: ServerEvent[];
  send(event: unknown): void;
  /** Resolves with the first event (already received or still to come) that matches. */
  next<T extends ServerEvent>(match: (e: ServerEvent) => e is T, timeoutMs?: number): Promise<T>;
  close(): void;
}

/** Node's own Event class: vitest's jsdom environment replaces the global one. */
async function nodeEventClass(): Promise<typeof Event> {
  const { MessageChannel } = await import('node:worker_threads');
  const { port1, port2 } = new MessageChannel();
  try {
    return await new Promise((resolve) => {
      port1.addEventListener('message', (e) => resolve(Object.getPrototypeOf(Object.getPrototypeOf(e)).constructor as typeof Event), { once: true });
      port1.start();
      port2.postMessage(0);
    });
  } finally {
    port1.close();
  }
}

/**
 * jsdom's WebSocket runs on undici's, which creates its events with the global Event and dispatches them on a Node
 * EventTarget; under vitest's jsdom environment that global is jsdom's, and the socket fails as it opens. Give undici
 * Node's Event while the server runs (app code creates no events of its own). Returns the undo.
 */
async function nodeEventsForSockets(): Promise<() => void> {
  if (!(globalThis as { jsdom?: unknown }).jsdom) return () => {};
  const jsdomEvent = globalThis.Event;
  globalThis.Event = await nodeEventClass();
  return () => { globalThis.Event = jsdomEvent; };
}

export async function startLiveServer(): Promise<LiveServer> {
  const restoreEvent = await nodeEventsForSockets();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'issho-int-'));
  const config = loadConfig({ HOUSEHOLD_CODE, DATA_DIR: dataDir, STATIC_DIR: path.join(dataDir, 'no-build') });
  const store = new Store(':memory:');
  const app = await buildApp({ config, store, ai: null, tts: null, precompress: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const sockets = new Set<WebSocket>();

  // The app's requests to this server go to inject; anything else to the real fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== url) return realFetch(input, init);
    if (init.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
      url: target.pathname + target.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers });
  }) as typeof fetch;

  const inject: LiveServer['inject'] = async (method, path, token, payload) => {
    const res = await app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { statusCode: res.statusCode, json: <T,>() => res.json() as T };
  };

  return {
    url,
    async register(name) {
      const res = await app.inject({ method: 'POST', url: '/api/register', payload: { householdCode: HOUSEHOLD_CODE, name } });
      if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
      return res.json() as RegisterResponse;
    },
    inject,
    socket(token) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
        sockets.add(ws);
        const events: ServerEvent[] = [];
        const waiters = new Set<(e: ServerEvent) => void>();
        ws.addEventListener('message', (m) => {
          const event = JSON.parse(String(m.data)) as ServerEvent;
          events.push(event);
          for (const w of [...waiters]) w(event);
        });
        ws.addEventListener('error', () => reject(new Error('partner socket failed')));
        ws.addEventListener('open', () => resolve({
          events,
          send: (event) => ws.send(JSON.stringify(event)),
          next: <T extends ServerEvent>(match: (e: ServerEvent) => e is T, timeoutMs = 5_000) => new Promise<T>((done, fail) => {
            const seen = events.find(match);
            if (seen) { done(seen); return; }
            const timer = setTimeout(() => { waiters.delete(waiter); fail(new Error('no matching server event')); }, timeoutMs);
            const waiter = (e: ServerEvent) => {
              if (!match(e)) return;
              clearTimeout(timer);
              waiters.delete(waiter);
              done(e);
            };
            waiters.add(waiter);
          }),
          close: () => ws.close(),
        }));
      });
    },
    async close() {
      for (const ws of sockets) ws.close();
      await app.close();
      store.close();
      restoreEvent();
      globalThis.fetch = realFetch;
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
