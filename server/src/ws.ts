import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData } from 'ws';
import { z } from 'zod';
import type { ClientEvent, Member } from '../../shared/api.ts';
import { authHook, currentMember, hashToken } from './auth.ts';
import type { AppContext } from './context.ts';

export const WS_PATH = '/api/ws';
export const WS_MAX_PAYLOAD = 16 * 1024;

const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('roleplay'),
    state: z.object({
      sessionId: z.string().min(1).max(100),
      scriptId: z.string().min(1).max(100),
      role: z.enum(['a', 'b']),
      lineIndex: z.number().int().min(0).max(10_000),
      status: z.enum(['waiting', 'active', 'done']),
    }),
  }),
  z.object({ type: z.literal('ping') }),
]) satisfies z.ZodType<ClientEvent>;

/** GET /api/ws?token=… — must be registered in its own scope (its auth hook reads the query). */
export function websocketRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Browsers can't set headers on a WebSocket, so the device token travels in the query string.
  app.addHook('onRequest', authHook(ctx, queryToken));

  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    const member = currentMember(request);

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

    const cameOnline = ctx.hub.join(member.id, socket, hashToken(queryToken(request)!));
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
  if (event.type === 'roleplay') {
    ctx.hub.broadcast({ type: 'roleplay', memberId: member.id, state: event.state }, { exceptMemberId: member.id });
  }
  // 'ping' only keeps NAT and proxy idle timers from closing the connection.
}
