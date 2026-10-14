import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AiCheckRequest,
  AiCheckResponse,
  AiTranslateRequest,
  AiTranslateResponse,
} from '../../../shared/api.ts';
import type { AiService } from '../ai.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';
import { enforceLimit } from '../rate-limit.ts';

const MAX_CONTEXT_LINES = 6;
const knownKanji = z.array(z.string().min(1).max(4)).max(5000).optional();

const AiCheckSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  knownKanji,
  // Lenient on count: keep the most recent lines rather than reject the request.
  context: z
    .array(z.string().max(1000))
    .max(50)
    .transform((lines) => lines.slice(-MAX_CONTEXT_LINES))
    .optional(),
}) satisfies z.ZodType<AiCheckRequest>;

const AiTranslateSchema = z.object({
  english: z.string().trim().min(1).max(500),
  knownKanji,
}) satisfies z.ZodType<AiTranslateRequest>;

export function aiRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 503 when AI is switched off, 429 past 30 calls a minute for this member. */
  function guard(request: FastifyRequest, reply: FastifyReply): AiService {
    if (!ctx.ai) throw new HttpError(503, 'ai_disabled');
    enforceLimit(ctx.limits.ai, currentMember(request).id, reply);
    return ctx.ai;
  }

  app.post('/api/ai/check', async (request, reply): Promise<AiCheckResponse> => {
    const ai = guard(request, reply);
    return ai.check(parseWith(AiCheckSchema, request.body));
  });

  app.post('/api/ai/translate', async (request, reply): Promise<AiTranslateResponse> => {
    const ai = guard(request, reply);
    return ai.translate(parseWith(AiTranslateSchema, request.body));
  });
}
