import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData } from 'ws';
import { z } from 'zod';
import { WS_CLOSE_UNPAIRED, type ClientEvent, type Member } from '../../shared/api.ts';
import { authenticate } from './auth.ts';
import type { AppContext } from './context.ts';
import { HttpError } from './errors.ts';

export const WS_PATH = '/api/ws';
export const WS_MAX_PAYLOAD = 16 * 1024;

const id = z.string().min(1).max(100);
const stage = z.literal([1, 2, 3, 4]);
const status = z.enum(['waiting', 'active', 'done']);

/** Relayed as parsed: fields the schema doesn't know are dropped. */
const TogetherLiveStateSchema = z.object({
  sessionId: id,
  session: z.enum(['A', 'B', 'C', 'monthly']),
  opener: id,
  plan: z
    .object({
      conversation: z.object({ scriptId: id, stage }).optional(),
      task: z.object({ unit: z.number().int().min(0).max(100), taskId: id, repeat: z.boolean() }).optional(),
      rolePlayId: id.optional(),
      storyId: id.optional(),
      capstoneUnit: z.number().int().min(0).max(100).optional(),
      showcase: z.boolean().optional(),
    })
    .optional(),
  quizIds: z
    .record(id, id)
    .refine((ids) => Object.keys(ids).length <= 10, 'too many quiz ids')
    .optional(),
  step: z.string().min(1).max(40),
  turn: id.optional(),
  index: z.number().int().min(0).max(10_000).optional(),
  timerStartedAt: z.number().int().min(0).optional(),
  status,
});

const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roleplay'),
    state: z.object({
      sessionId: id,
      scriptId: id,
      role: z.enum(['a', 'b']),
      lineIndex: z.number().int().min(0).max(10_000),
      status,
      stage: stage.optional(),
    }),
  }),
  z.object({ type: z.literal('live'), state: TogetherLiveStateSchema }),
  z.object({ type: z.literal('ping') }),
]) satisfies z.ZodType<ClientEvent>;

/** GET /api/ws?token=… — must be registered in its own scope (its auth hook reads the query). */
export function websocketRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Browsers can't set headers on a WebSocket, so the device token travels in the query string.
  // A browser never sees why an upgrade was refused (any HTTP error is just close code 1006), so
  // an unknown token gets its socket and is closed with WS_CLOSE_UNPAIRED: the phone then knows
  // to pair again instead of retrying forever.
  app.addHook('onRequest', async (request) => {
    const device = authenticate(ctx, queryToken(request));
    if (!device && !request.ws) throw new HttpError(401, 'unauthorized');
    request.member = device?.member ?? null;
    request.deviceTokenHash = device?.tokenHash ?? null;
  });

  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    const member = request.member;
    const tokenHash = request.deviceTokenHash;
    if (!member || !tokenHash) {
      socket.close(WS_CLOSE_UNPAIRED, 'device not paired');
      return;
    }

    // Handlers are attached synchronously so no early frame is missed.
    socket.on('message', (data, isBinary) => {
      if (!isBinary) handleClientEvent(ctx, member, data);
    });
    socket.on('close', () => {
      if (ctx.hub.leave(member.id, socket)) {
        ctx.store.touchMember(member.id, ctx.now());
        ctx.hub.broadcast({ type: 'presence', memberId: member.id, online: false }, { exceptMemberId: member.id });
      }
    });

    const cameOnline = ctx.hub.join(member.id, socket, tokenHash);
    for (const memberId of ctx.hub.onlineMemberIds()) {
      if (memberId !== member.id) ctx.hub.send(socket, { type: 'presence', memberId, online: true });
    }
    if (cameOnline) {
      ctx.hub.broadcast({ type: 'presence', memberId: member.id, online: true }, { exceptMemberId: member.id });
    }
  });
}

function queryToken(request: FastifyRequest): string | null {
  const { token } = request.query as { token?: unknown };
  return typeof token === 'string' ? token : null;
}

function handleClientEvent(ctx: AppContext, member: Member, data: RawData): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return;
  }
  const result = ClientEventSchema.safeParse(parsed);
  if (!result.success) return;

  const event = result.data;
  // Shared positions go to the other members only: the sender's phone already has them.
  if (event.type === 'roleplay') {
    ctx.hub.broadcast({ type: 'roleplay', memberId: member.id, state: event.state }, { exceptMemberId: member.id });
  } else if (event.type === 'live') {
    ctx.hub.broadcast({ type: 'live', memberId: member.id, state: event.state }, { exceptMemberId: member.id });
  }
  // 'ping' only keeps NAT and proxy idle timers from closing the connection.
}
