import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TogetherEvent, TogetherEventRequest, TogetherState } from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { isDayKey, mondayOf } from '../days.ts';
import { parseWith } from '../errors.ts';
import { foldTogether } from '../together.ts';
import { householdToday } from './stats.ts';

const dayKey = z.string().refine(isDayKey, 'must be a YYYY-MM-DD date');
const id = z.string().min(1).max(100);
const session = z.enum(['A', 'B', 'C', 'monthly']);
const stage = z.literal([1, 2, 3, 4]);
const minutes = z.number().min(0).max(24 * 60);
const count = z.number().int().min(0).max(1_000_000);

const TogetherEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('slots'),
    slots: z
      .array(
        z.object({
          session: z.enum(['A', 'B', 'C']),
          weekday: z.literal([1, 2, 3, 4, 5, 6, 7]),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
        }),
      )
      .max(7),
  }),
  z.object({
    type: z.literal('goal'),
    goal: z.object({ text: z.string().trim().min(1).max(300), targetDate: dayKey }),
  }),
  z.object({ type: z.literal('session-done'), session, date: dayKey, minutes }),
  z.object({ type: z.literal('smooth'), scriptId: id, stage, both: z.boolean().optional() }),
  z.object({ type: z.literal('task-done'), taskId: id, date: dayKey, repeat: z.boolean() }),
  z.object({
    type: z.literal('checkin'),
    checkin: z.object({
      counts: z.object({ kanji: count, words: count, grammar: count, minutes }),
      canDo: id.optional(),
      note: z.string().max(1000).optional(),
      plannedRest: z.array(dayKey).max(7).optional(),
    }),
  }),
  z.object({ type: z.literal('capstone-done'), unit: z.number().int().min(1).max(100), date: dayKey }),
]) satisfies z.ZodType<TogetherEvent>;

const TogetherEventRequestSchema = z.object({
  clientId: id,
  week: dayKey,
  event: TogetherEventSchema,
}) satisfies z.ZodType<TogetherEventRequest>;

export function togetherRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/together', async (): Promise<TogetherState> => togetherState(ctx));

  /**
   * Idempotent on (member, clientId): a phone resending from its outbox gets 200 and the current
   * state. A new event is stored and every device of every member (the sender's other devices too)
   * hears `together`, so they all refresh and credit the same sessions.
   */
  app.post('/api/together/events', async (request, reply): Promise<TogetherState> => {
    const member = currentMember(request);
    const body = parseWith(TogetherEventRequestSchema, request.body);
    const stored = ctx.store.insertTogetherEvent({
      memberId: member.id,
      clientId: body.clientId,
      // Phones send the Monday of their week; any day of it files the event under that week.
      week: mondayOf(body.week),
      createdAt: ctx.now().toISOString(),
      event: body.event,
    });
    if (stored) {
      ctx.hub.broadcast({ type: 'together' });
      reply.code(201);
    }
    return togetherState(ctx);
  });
}

function togetherState(ctx: AppContext): TogetherState {
  const members = ctx.store.listMembers().map((member) => member.id);
  return foldTogether(ctx.store.listTogetherEvents(), members, householdToday(ctx));
}
