import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CreateQuizRequest,
  PartnerQuizItem,
  Quiz,
  QuizItem,
  QuizItemVerdict,
  QuizKind,
  QuizResultRequest,
  QuizzesResponse,
} from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';

const LIST_LIMIT = 20;
const MAX_ITEMS = 50;
/** Items per quiz of each together kind. */
const MAX_TOGETHER_ITEMS: Record<Exclude<QuizKind, 'kanji'>, number> = { partner: 10, dictation: 5, monthly: 20 };
const MAX_KEY = 80;
const MAX_TEXT = 200;
const char = z.string().min(1).max(4);
/** A quiz asks for kanji: one Han character each (no kana, words or punctuation). */
const kanji = char.regex(/^\p{Script=Han}$/u, 'must be a single kanji');
const recipient = z.uuid();

const QuizKindSchema = z.object({ kind: z.enum(['kanji', 'partner', 'dictation', 'monthly']).default('kanji') });

/** Keeps each item's first place: a repeated item would be asked twice and counted twice. */
function firstOfEach<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const KanjiQuizSchema = z.object({
  toMemberId: recipient,
  items: z
    .array(z.object({ char: kanji }))
    .min(1)
    .max(MAX_ITEMS)
    .transform((items) => firstOfEach(items, (item) => item.char)),
});

const PartnerItemSchema = z.object({
  key: z.string().min(1).max(MAX_KEY),
  kind: z.enum(['write', 'read', 'produce', 'build']),
  prompt: z.string().trim().min(1).max(MAX_TEXT),
  answer: z.string().trim().min(1).max(MAX_TEXT),
}) satisfies z.ZodType<PartnerQuizItem>;

function togetherQuizSchema(kind: Exclude<QuizKind, 'kanji'>) {
  const item = kind === 'dictation' ? PartnerItemSchema.extend({ kind: z.literal('write') }) : PartnerItemSchema;
  return z.object({
    toMemberId: recipient,
    items: z
      .array(item)
      .min(1)
      .max(MAX_TOGETHER_ITEMS[kind])
      .transform((items) => firstOfEach<PartnerQuizItem>(items, (entry) => entry.key)),
  });
}

const TOGETHER_SCHEMAS = {
  partner: togetherQuizSchema('partner'),
  dictation: togetherQuizSchema('dictation'),
  monthly: togetherQuizSchema('monthly'),
};

const QuizResultSchema = z
  .object({
    correct: z.number().int().min(0),
    total: z.number().int().min(0).max(MAX_ITEMS),
    missed: z.array(z.string().max(MAX_KEY)).max(MAX_ITEMS),
    verdicts: z
      .array(z.object({ key: z.string().min(1).max(MAX_KEY), verdict: z.enum(['right', 'close', 'wrong']) }))
      .max(MAX_ITEMS)
      .optional(),
  })
  .refine((result) => result.correct <= result.total, 'correct must not exceed total') satisfies z.ZodType<QuizResultRequest>;

const QuizParamsSchema = z.object({ id: z.uuid() });

function parseCreate(body: unknown): CreateQuizRequest & { kind: QuizKind } {
  const { kind } = parseWith(QuizKindSchema, body);
  const parsed = kind === 'kanji' ? parseWith(KanjiQuizSchema, body) : parseWith(TOGETHER_SCHEMAS[kind], body);
  return { kind, toMemberId: parsed.toMemberId, items: parsed.items as QuizItem[] };
}

export function quizRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/quizzes', async (request): Promise<QuizzesResponse> => {
    const member = currentMember(request);
    return {
      inbox: ctx.store.listQuizzes('inbox', member.id, LIST_LIMIT),
      sent: ctx.store.listQuizzes('sent', member.id, LIST_LIMIT),
    };
  });

  /**
   * kanji: the sender asks the recipient. partner, dictation and monthly: the sender is the
   * answerer (its phone built the items from its own cards) and the recipient asks and grades.
   */
  app.post('/api/quizzes', async (request, reply): Promise<Quiz> => {
    const member = currentMember(request);
    const body = parseCreate(request.body);
    if (body.toMemberId === member.id || !ctx.store.getMember(body.toMemberId)) {
      throw new HttpError(400, 'invalid_recipient');
    }

    const quiz = ctx.store.insertQuiz({
      kind: body.kind,
      fromMemberId: member.id,
      toMemberId: body.toMemberId,
      createdAt: ctx.now().toISOString(),
      items: body.items,
    });
    ctx.hub.sendToMembers([quiz.fromMemberId, quiz.toMemberId], { type: 'quiz', quiz });
    reply.code(201);
    return quiz;
  });

  /** Posted by the recipient: the answerer of a kanji quiz, the asker of the together kinds. */
  app.post('/api/quizzes/:id/result', async (request): Promise<Quiz> => {
    const member = currentMember(request);
    const { id } = parseWith(QuizParamsSchema, request.params);
    const body = parseWith(QuizResultSchema, request.body);

    const quiz = ctx.store.getQuiz(id);
    if (!quiz || quiz.toMemberId !== member.id) throw new HttpError(404, 'not_found');
    // A retried submission (e.g. from a flaky connection) gets the stored result back unchanged.
    if (quiz.result) return quiz;

    const finishedAt = ctx.now().toISOString();
    const result =
      quiz.kind === 'kanji'
        ? kanjiResult(quiz, body, finishedAt)
        : verdictResult(quiz, body.verdicts, finishedAt);
    const finished = ctx.store.setQuizResult(id, result);
    ctx.hub.sendToMembers([finished.fromMemberId, finished.toMemberId], { type: 'quiz', quiz: finished });
    return finished;
  });
}

/** v1: the answerer's own count; only the quiz's own kanji can be missed, each once. */
function kanjiResult(quiz: Quiz, body: QuizResultRequest, finishedAt: string): NonNullable<Quiz['result']> {
  const asked = new Set(quiz.items.map((item) => ('char' in item ? item.char : item.key)));
  return {
    correct: body.correct,
    total: body.total,
    missed: [...new Set(body.missed)].filter((c) => asked.has(c)),
    finishedAt,
  };
}

/**
 * Together kinds: exactly one verdict per item. The counts follow from the verdicts (correct =
 * number right, total = number of items, missed = the items not right, in quiz order), so the
 * answerer's phone grades exactly what the asker saw.
 */
function verdictResult(
  quiz: Quiz,
  verdicts: readonly QuizItemVerdict[] | undefined,
  finishedAt: string,
): NonNullable<Quiz['result']> {
  if (!verdicts) throw new HttpError(400, 'verdicts_required');
  const keys = quiz.items.map((item) => ('key' in item ? item.key : item.char));
  const byKey = new Map(verdicts.map((entry) => [entry.key, entry.verdict] as const));
  if (verdicts.length !== keys.length || byKey.size !== keys.length || keys.some((key) => !byKey.has(key))) {
    throw new HttpError(400, 'verdicts_mismatch');
  }
  const ordered = keys.map((key) => ({ key, verdict: byKey.get(key)! }));
  return {
    correct: ordered.filter((entry) => entry.verdict === 'right').length,
    total: keys.length,
    missed: ordered.filter((entry) => entry.verdict !== 'right').map((entry) => entry.key),
    finishedAt,
    verdicts: ordered,
  };
}
