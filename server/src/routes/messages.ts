import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatMessage, SendMessageRequest } from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { MAX_WRITTEN_BEFORE_MS } from '../db.ts';
import { HttpError, parseWith } from '../errors.ts';

const MAX_TEXT = 2000;

const SendMessageSchema = z.object({
  clientId: z.string().min(1).max(100),
  writtenAt: z.iso.datetime({ offset: true }).optional(),
  kind: z.enum(['text', 'voice']),
  text: z.string().max(MAX_TEXT),
  transcript: z.string().max(MAX_TEXT).optional(),
  audioId: z.uuid().optional(),
  /** The sender's output-step sentence of the day. */
  tag: z.literal('daily').optional(),
}) satisfies z.ZodType<SendMessageRequest>;

const ListQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function messageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/messages', async (request): Promise<ChatMessage[]> => {
    const { after, limit } = parseWith(ListQuerySchema, request.query);
    return ctx.store.listMessages(after, limit);
  });

  app.post('/api/messages', async (request, reply): Promise<ChatMessage> => {
    const member = currentMember(request);
    const body = parseWith(SendMessageSchema, request.body);

    // Phones retry from their outbox; the same clientId always gets the original message back.
    const existing = ctx.store.findMessage(member.id, body.clientId);
    if (existing) return existing;

    if (body.kind === 'text') {
      if (!body.text.trim()) throw new HttpError(400, 'text_required');
      if (body.audioId) throw new HttpError(400, 'unexpected_audio');
    } else {
      if (!body.audioId) throw new HttpError(400, 'audio_required');
      if (ctx.store.getVoice(body.audioId)?.memberId !== member.id) {
        throw new HttpError(400, 'unknown_audio');
      }
    }

    const now = ctx.now();
    const message = ctx.store.insertMessage({
      clientId: body.clientId,
      memberId: member.id,
      createdAt: now.toISOString(),
      writtenAt: body.writtenAt && writtenAt(body.writtenAt, now),
      kind: body.kind,
      text: body.text,
      transcript: body.transcript,
      audioId: body.audioId,
      tag: body.tag,
    });
    ctx.hub.broadcast({ type: 'message', message });
    reply.code(201);
    return message;
  });
}

/**
 * When a message was written, as the phone says, kept between a week before `now` and `now`: a
 * phone's clock may be off, and a message can't be written after it arrived.
 */
function writtenAt(claimed: string, now: Date): string {
  const time = Math.min(now.getTime(), Math.max(now.getTime() - MAX_WRITTEN_BEFORE_MS, Date.parse(claimed)));
  return new Date(time).toISOString();
}
