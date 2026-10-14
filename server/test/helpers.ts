import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { RegisterResponse, ServerEvent } from '../../shared/api.ts';
import type { AiService } from '../src/ai.ts';
import { buildApp, loggerOptions } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';

export const HOUSEHOLD_CODE = 'correct horse battery staple';

export interface TestServer {
  app: FastifyInstance;
  store: Store;
  dataDir: string;
  register(name: string): Promise<RegisterResponse>;
  close(): Promise<void>;
}

export interface TestServerOptions {
  ai?: AiService | null;
  now?: () => Date;
  staticDir?: string;
  /** Extra environment variables for loadConfig(). */
  env?: Record<string, string>;
  /** Collects the server's JSON log lines (production logger settings) when given. */
  logLines?: string[];
}

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'issho-test-'));
  const config = loadConfig({
    HOUSEHOLD_CODE,
    DATA_DIR: dataDir,
    STATIC_DIR: options.staticDir ?? path.join(dataDir, 'no-build'),
    ...options.env,
  });
  const store = new Store(':memory:');
  const app = await buildApp({ config, store, ai: options.ai, now: options.now, logger: captureLogs(options.logLines) });
  await app.ready();

  return {
    app,
    store,
    dataDir,
    async register(name) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: { householdCode: HOUSEHOLD_CODE, name },
      });
      if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
      return res.json<RegisterResponse>();
    },
    async close() {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function captureLogs(lines: string[] | undefined): FastifyServerOptions['logger'] {
  if (!lines) return undefined;
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { ...(loggerOptions('info') as object), stream } as FastifyServerOptions['logger'];
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

type Match = (event: ServerEvent) => boolean;

/** Starts listening on a random local port and returns the ws:// base URL. */
export async function listen(server: TestServer): Promise<string> {
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

/** A real WebSocket client (Node's built-in one), like a phone would open. */
export async function openSocket(base: string, token: string, path = '/api/ws') {
  const ws = new WebSocket(`${base}${path}?token=${encodeURIComponent(token)}`);
  // Subscribe before the socket opens: the server sends presence right after the upgrade.
  const events = collectEvents((onText) => ws.addEventListener('message', (e) => onText(String(e.data))));
  const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true });
  });
  return {
    ws,
    events,
    send: (event: unknown) => ws.send(typeof event === 'string' ? event : JSON.stringify(event)),
    async close() {
      ws.close();
      await closed;
    },
  };
}

/**
 * Collects server events from a socket. `next(match)` resolves with the first not-yet-claimed
 * event that matches, waiting for it if needed; each event is claimed once.
 */
export function collectEvents(subscribe: (onText: (text: string) => void) => void) {
  const all: ServerEvent[] = [];
  const unclaimed: ServerEvent[] = [];
  const waiters: { match: Match; resolve: (event: ServerEvent) => void }[] = [];

  subscribe((text) => {
    const event = JSON.parse(text) as ServerEvent;
    all.push(event);
    const waiter = waiters.find((w) => w.match(event));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    } else {
      unclaimed.push(event);
    }
  });

  return {
    all,
    next(match: Match, timeoutMs = 1000): Promise<ServerEvent> {
      const index = unclaimed.findIndex(match);
      if (index >= 0) return Promise.resolve(unclaimed.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve: (event: ServerEvent) => {
            clearTimeout(timer);
            resolve(event);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('timed out waiting for a server event'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
