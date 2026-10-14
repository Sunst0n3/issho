import { mkdirSync, readFileSync } from 'node:fs';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { AiError, describeAiFailure, type AiService } from './ai.ts';
import { authHook, bearerToken } from './auth.ts';
import { dataPaths, type Config } from './config.ts';
import type { AppContext } from './context.ts';
import type { Store } from './db.ts';
import { clientErrorCode, HttpError } from './errors.ts';
import { Hub } from './hub.ts';
import { RateLimiter } from './rate-limit.ts';
import { aiRoutes } from './routes/ai.ts';
import { healthRoutes } from './routes/health.ts';
import { messageRoutes } from './routes/messages.ts';
import { quizRoutes } from './routes/quizzes.ts';
import { registerRoutes } from './routes/register.ts';
import { statsRoutes } from './routes/stats.ts';
import { voiceRoutes } from './routes/voice.ts';
import { notFoundHandler, registerStatic } from './static.ts';
import { startVoiceCleanup } from './voice-cleanup.ts';
import { websocketRoutes, WS_MAX_PAYLOAD, WS_PATH } from './ws.ts';

/** JSON bodies are small (the largest is a stats upload with ~2,000 known kanji). */
const JSON_BODY_LIMIT = 256 * 1024;
const MINUTE = 60_000;
const SOCKET_CLOSE_GRACE_MS = 2000;

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface BuildAppOptions {
  config: Config;
  store: Store;
  /** null or omitted: AI routes answer 503 ai_disabled. */
  ai?: AiService | null;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
  /** WebSocket ping interval; tests shorten it. */
  heartbeatMs?: number;
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
    now: options.now ?? (() => new Date()),
    householdName: () => store.householdName() ?? config.householdName,
    voiceDir: dataPaths(config.dataDir).voice,
    version: VERSION,
    limits: {
      register: new RateLimiter(5, MINUTE),
      ai: new RateLimiter(30, MINUTE),
    },
  };
  mkdirSync(ctx.voiceDir, { recursive: true });

  app.decorateRequest('member', null);
  app.setErrorHandler(handleError);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
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
    statsRoutes(api, ctx);
    messageRoutes(api, ctx);
    voiceRoutes(api, ctx);
    quizRoutes(api, ctx);
    aiRoutes(api, ctx);
  });
  await app.register(async (sockets) => websocketRoutes(sockets, ctx));

  const hasApp = await registerStatic(app, config.staticDir);
  app.setNotFoundHandler(notFoundHandler(hasApp));

  ctx.hub.startHeartbeat(options.heartbeatMs);
  const voiceCleanup = await startVoiceCleanup({ store, voiceDir: ctx.voiceDir, now: ctx.now, log: app.log });
  app.addHook('onClose', async () => voiceCleanup.stop());
  return app;
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
