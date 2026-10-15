import { mkdirSync, readFileSync } from 'node:fs';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { AiError, describeAiFailure, grammarTitlesLoader, type AiService } from './ai.ts';
import { authHook, bearerToken } from './auth.ts';
import { dataPaths, type Config } from './config.ts';
import type { AppContext } from './context.ts';
import type { Store } from './db.ts';
import { clientErrorCode, HttpError } from './errors.ts';
import { Hub } from './hub.ts';
import { RateLimiter } from './rate-limit.ts';
import { aiRoutes } from './routes/ai.ts';
import { healthRoutes } from './routes/health.ts';
import { meRoutes } from './routes/me.ts';
import { messageRoutes } from './routes/messages.ts';
import { quizRoutes } from './routes/quizzes.ts';
import { registerRoutes } from './routes/register.ts';
import { statsRoutes } from './routes/stats.ts';
import { togetherRoutes } from './routes/together.ts';
import { voiceRoutes } from './routes/voice.ts';
import { precompressStatic, removeStaleCopies } from './precompress.ts';
import { notFoundHandler, registerStatic } from './static.ts';
import type { TtsService } from './tts.ts';
import { ttsRoutes } from './tts-routes.ts';
import { startVoiceCleanup } from './voice-cleanup.ts';
import { websocketRoutes, WS_MAX_PAYLOAD, WS_PATH } from './ws.ts';

/** JSON bodies are small (the largest is a stats upload with ~2,000 known kanji). */
const JSON_BODY_LIMIT = 256 * 1024;
const MINUTE = 60_000;
const SOCKET_CLOSE_GRACE_MS = 2000;
/** How long a browser may reuse a CORS preflight answer. */
const PREFLIGHT_MAX_AGE_S = 600;

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface BuildAppOptions {
  config: Config;
  store: Store;
  /** null or omitted: AI routes answer 503 ai_disabled. */
  ai?: AiService | null;
  /** null or omitted: POST /api/tts answers 503 tts_unavailable and health reports ttsEnabled false. */
  tts?: TtsService | null;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
  /** WebSocket ping interval; tests shorten it. */
  heartbeatMs?: number;
  /** How often open sockets are checked for revoked devices; tests shorten it. */
  pairingCheckMs?: number;
  /**
   * Write compressed copies of the built app's text files in the background at startup
   * (default true). Tests that compare compressed responses call precompressStatic() themselves.
   */
  precompress?: boolean;
}

/** pino options for Fastify: info level to stdout, with device tokens scrubbed from logged URLs. */
export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: redactToken(request.url),
        remoteAddress: request.ip,
      }),
    },
  };
}

function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]');
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, store } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: config.trustProxy,
  });

  const ctx: AppContext = {
    config,
    store,
    hub: new Hub({ isPaired: (tokenHash) => store.memberForTokenHash(tokenHash) !== undefined }),
    ai: options.ai ?? null,
    tts: options.tts ?? null,
    now: options.now ?? (() => new Date()),
    householdName: () => store.householdName() ?? config.householdName,
    grammarTitles: grammarTitlesLoader(config.staticDir),
    voiceDir: dataPaths(config.dataDir).voice,
    version: VERSION,
    limits: {
      register: new RateLimiter(5, MINUTE),
      ai: new RateLimiter(30, MINUTE),
    },
  };
  mkdirSync(ctx.voiceDir, { recursive: true });

  app.decorateRequest('member', null);
  app.decorateRequest('deviceTokenHash', null);
  app.setErrorHandler(handleError);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (isApiPath(request.url)) allowAnyOrigin(request, reply);
  });
  // CORS preflight for every API route (see allowAnyOrigin).
  app.options('/api/*', { logLevel: 'warn' }, async (request, reply) => {
    reply
      .header('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS')
      .header('access-control-allow-headers', 'authorization, content-type, accept')
      .header('access-control-max-age', String(PREFLIGHT_MAX_AGE_S));
    // Chrome asks before a public page may call a server on the home network.
    if (request.headers['access-control-request-private-network'] === 'true') {
      reply.header('access-control-allow-private-network', 'true');
    }
    return reply.code(204).send();
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: WS_MAX_PAYLOAD },
    errorHandler(error, socket, request) {
      request.log.warn({ reason: error.message }, 'websocket error');
      socket.terminate();
    },
    async preClose() {
      ctx.hub.stopHeartbeat();
      await closeSockets(app);
    },
  });
  // @fastify/websocket upgrades a socket on any GET route and then closes it, logging the full URL
  // (device token included). Only the real socket route may upgrade. This must run after the
  // plugin's own onRequest hook, which marks `request.ws` so the refused socket gets destroyed.
  app.addHook('onRequest', async (request) => {
    if (request.ws && request.routeOptions.url !== WS_PATH) throw new HttpError(404, 'not_found');
  });
  await app.register(fastifyMultipart);

  healthRoutes(app, ctx);
  registerRoutes(app, ctx);

  await app.register(async (api) => {
    api.addHook('onRequest', authHook(ctx, (request) => bearerToken(request.headers.authorization)));
    meRoutes(api, ctx);
    statsRoutes(api, ctx);
    messageRoutes(api, ctx);
    voiceRoutes(api, ctx);
    quizRoutes(api, ctx);
    togetherRoutes(api, ctx);
    aiRoutes(api, ctx);
    ttsRoutes(api, ctx);
  });
  await app.register(async (sockets) => websocketRoutes(sockets, ctx));

  const hasApp = await registerStatic(app, config.staticDir);
  app.setNotFoundHandler(notFoundHandler(hasApp));
  if (hasApp && options.precompress !== false) await startPrecompressing(app, config.staticDir);

  ctx.hub.startHeartbeat(options.heartbeatMs, options.pairingCheckMs);
  const voiceCleanup = await startVoiceCleanup({ store, voiceDir: ctx.voiceDir, now: ctx.now, log: app.log });
  app.addHook('onClose', async () => {
    voiceCleanup.stop();
    ctx.tts?.close();
  });
  return app;
}

function isApiPath(url: string): boolean {
  const pathname = url.split('?')[0];
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Lets a page from any origin read API responses, so the app opened at one address can use the
 * home server at another ("Advanced: server address"). Safe for any origin: requests carry the
 * device token as a bearer header, never a cookie, so another site can't act as a paired phone.
 * Set before routing, so errors (a 401 that makes the phone pair again) are readable too.
 */
function allowAnyOrigin(request: FastifyRequest, reply: FastifyReply): void {
  if (!request.headers.origin) return;
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-expose-headers', 'retry-after');
}

/**
 * Compresses the built app's text files in the background (only missing or outdated copies), so
 * the server answers at once. First, before it answers, it removes copies an older build left
 * (quick: no compressing), so those are never served meanwhile. Can't write there (a read-only
 * image)? Then it serves the copies made at build time, or the files as they are.
 */
async function startPrecompressing(app: FastifyInstance, root: string): Promise<void> {
  try {
    const removed = await removeStaleCopies(root);
    if (removed > 0) app.log.info({ removed }, 'removed compressed copies of an older build');
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    app.log.warn({ code: error.code, reason: error.message }, 'could not check the compressed app files');
  }
  const abort = new AbortController();
  const done = precompressStatic(root, abort.signal).then(
    ({ written }) => {
      if (written > 0) app.log.info({ written }, 'compressed the app files');
    },
    (error: NodeJS.ErrnoException) => {
      app.log.warn({ code: error.code, reason: error.message }, 'could not compress the app files; serving them as they are');
    },
  );
  app.addHook('onClose', async () => {
    abort.abort();
    await done;
  });
}

/** Asks every client to reconnect later (1001), then drops any that don't finish the close handshake. */
async function closeSockets(app: FastifyInstance): Promise<void> {
  const server = app.websocketServer;
  for (const client of server.clients) client.close(1001, 'server restarting');
  const timer = setTimeout(() => {
    for (const client of server.clients) client.terminate();
  }, SOCKET_CLOSE_GRACE_MS);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(timer);
}

function handleError(
  error: Error & { statusCode?: number },
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof HttpError) {
    return reply
      .code(error.statusCode)
      .send(error.detail ? { error: error.code, detail: error.detail } : { error: error.code });
  }
  if (error instanceof AiError) {
    if (error.status >= 500 || error.status === 429) {
      request.log.warn({ code: error.code, upstream: describeAiFailure(error) }, 'ai request failed');
    }
    return reply.code(error.status).send({ error: error.code });
  }
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return reply.code(status).send({ error: clientErrorCode(status) });
  }
  request.log.error({ err: error }, 'request failed');
  return reply.code(500).send({ error: 'internal' });
}
