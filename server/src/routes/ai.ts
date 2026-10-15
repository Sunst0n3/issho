import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AiCanDoRequest,
  AiCanDoResponse,
  AiCheckRequest,
  AiCheckResponse,
  AiRecapRequest,
  AiRecapResponse,
  AiReportRequest,
  AiRolePlayRequest,
  AiRolePlayResponse,
  AiTranslateRequest,
  AiTranslateResponse,
} from '../../../shared/api.ts';
import type { AiService } from '../ai.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';
import { enforceLimit } from '../rate-limit.ts';

const MAX_CONTEXT_LINES = 6;
const MAX_HISTORY_TURNS = 30;
const MAX_LINES = 30;
const MAX_TEXT = 1000;
const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => text.trim().length > 0, 'must not be blank');
const shortText = z.string().trim().min(1).max(200);

const knownKanji = z.array(z.string().min(1).max(4)).max(5000).optional();
/** Shared by every request that carries what the learner knows. */
const LearnerContextShape = {
  knownKanji,
  knownGrammar: z.array(z.string().min(1).max(80)).max(1000).optional(),
  knownWords: z.array(z.string().min(1).max(40)).max(3000).optional(),
  register: z.enum(['plain', 'polite']).optional(),
};

const AiCheckSchema = z.object({
  ...LearnerContextShape,
  // Not trimmed: issue offsets refer to the text exactly as the phone sent it.
  text: nonBlank(MAX_TEXT),
  // Lenient on count: keep the most recent lines rather than reject the request.
  context: z
    .array(z.string().max(MAX_TEXT))
    .max(50)
    .transform((lines) => lines.slice(-MAX_CONTEXT_LINES))
    .optional(),
  mode: z.enum(['prompt', 'reveal']).optional(),
  target: z.string().max(200).optional(),
  firstAttempt: z.string().max(MAX_TEXT).optional(),
}) satisfies z.ZodType<AiCheckRequest>;

const AiTranslateSchema = z.object({
  english: z.string().trim().min(1).max(500),
  knownKanji,
}) satisfies z.ZodType<AiTranslateRequest>;

const AiRolePlaySchema = z.object({
  ...LearnerContextShape,
  taskId: z.string().min(1).max(100),
  aiRole: shortText,
  goal: z.string().trim().min(1).max(500),
  history: z
    .array(z.object({ speaker: z.enum(['ai', 'a', 'b']), text: z.string().max(500) }))
    .max(MAX_HISTORY_TURNS),
}) satisfies z.ZodType<AiRolePlayRequest>;

const AiRecapSchema = z.object({
  ...LearnerContextShape,
  goal: z.string().trim().min(1).max(500),
  lines: z.array(z.string().max(500)).min(1).max(MAX_LINES),
}) satisfies z.ZodType<AiRecapRequest>;

const AiCanDoSchema = z.object({
  canDoId: z.string().min(1).max(100),
  kind: z.enum(['speak', 'write']),
  rubric: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  text: nonBlank(MAX_TEXT),
}) satisfies z.ZodType<AiCanDoRequest>;

const AiReportSchema = z.object({
  kind: z.enum(['check', 'recap', 'roleplay', 'cando']),
  text: z.string().max(2000),
  issue: z
    .object({
      quote: z.string().max(MAX_TEXT),
      start: z.number().int().min(0).nullable(),
      end: z.number().int().min(0).nullable(),
      type: z.enum(['particle', 'conjugation', 'word-choice', 'kanji', 'register', 'other']),
      uncertain: z.boolean(),
      hint: z.string().max(MAX_TEXT),
    })
    .optional(),
  note: z.string().max(MAX_TEXT).optional(),
}) satisfies z.ZodType<AiReportRequest>;

export function aiRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 503 when AI is switched off, 429 past 30 calls a minute for this member. */
  function guard(request: FastifyRequest, reply: FastifyReply): AiService {
    if (!ctx.ai) throw new HttpError(503, 'ai_disabled');
    enforceLimit(ctx.limits.ai, currentMember(request).id, reply);
    return ctx.ai;
  }

  app.post('/api/ai/check', async (request, reply): Promise<AiCheckResponse> => {
    const ai = guard(request, reply);
    return ai.check(parseWith(AiCheckSchema, request.body), ctx.grammarTitles());
  });

  app.post('/api/ai/translate', async (request, reply): Promise<AiTranslateResponse> => {
    const ai = guard(request, reply);
    return ai.translate(parseWith(AiTranslateSchema, request.body));
  });

  app.post('/api/ai/roleplay', async (request, reply): Promise<AiRolePlayResponse> => {
    const ai = guard(request, reply);
    return ai.rolePlay(parseWith(AiRolePlaySchema, request.body), ctx.grammarTitles());
  });

  app.post('/api/ai/recap', async (request, reply): Promise<AiRecapResponse> => {
    const ai = guard(request, reply);
    return ai.recap(parseWith(AiRecapSchema, request.body), ctx.grammarTitles());
  });

  app.post('/api/ai/cando', async (request, reply): Promise<AiCanDoResponse> => {
    const ai = guard(request, reply);
    return ai.canDo(parseWith(AiCanDoSchema, request.body));
  });

  /** "This tip seems wrong": kept for whoever tunes the prompts. Works with the AI switched off too. */
  app.post('/api/ai/report', async (request, reply) => {
    const member = currentMember(request);
    enforceLimit(ctx.limits.ai, member.id, reply);
    ctx.store.insertAiReport(member.id, parseWith(AiReportSchema, request.body), ctx.now());
    return reply.code(204).send();
  });
}
