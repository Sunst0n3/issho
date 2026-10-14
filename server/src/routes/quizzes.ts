import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CreateQuizRequest,
  Quiz,
  QuizResultRequest,
  QuizzesResponse,
} from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';

const LIST_LIMIT = 20;
const MAX_ITEMS = 50;
const char = z.string().min(1).max(4);

const CreateQuizSchema = z.object({
  toMemberId: z.uuid(),
  items: z.array(z.object({ char })).min(1).max(MAX_ITEMS),
}) satisfies z.ZodType<CreateQuizRequest>;

const QuizResultSchema = z
  .object({
    correct: z.number().int().min(0),
    total: z.number().int().min(0).max(MAX_ITEMS),
    missed: z.array(char).max(MAX_ITEMS),
  })
  .refine((result) => result.correct <= result.total, 'correct must not exceed total') satisfies z.ZodType<QuizResultRequest>;

const QuizParamsSchema = z.object({ id: z.uuid() });

export function quizRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/quizzes', async (request): Promise<QuizzesResponse> => {
    const member = currentMember(request);
    return {
      inbox: ctx.store.listQuizzes('inbox', member.id, LIST_LIMIT),
      sent: ctx.store.listQuizzes('sent', member.id, LIST_LIMIT),
    };
  });

  app.post('/api/quizzes', async (request, reply): Promise<Quiz> => {
    const member = currentMember(request);
    const body = parseWith(CreateQuizSchema, request.body);
    if (body.toMemberId === member.id || !ctx.store.getMember(body.toMemberId)) {
      throw new HttpError(400, 'invalid_recipient');
    }

    const quiz = ctx.store.insertQuiz({
      fromMemberId: member.id,
      toMemberId: body.toMemberId,
      createdAt: ctx.now().toISOString(),
      items: body.items,
    });
    ctx.hub.sendToMembers([quiz.fromMemberId, quiz.toMemberId], { type: 'quiz', quiz });
    reply.code(201);
    return quiz;
  });

  app.post('/api/quizzes/:id/result', async (request): Promise<Quiz> => {
    const member = currentMember(request);
    const { id } = parseWith(QuizParamsSchema, request.params);
    const body = parseWith(QuizResultSchema, request.body);

    const quiz = ctx.store.getQuiz(id);
    if (!quiz || quiz.toMemberId !== member.id) throw new HttpError(404, 'not_found');
    // A retried submission (e.g. from a flaky connection) gets the stored result back unchanged.
    if (quiz.result) return quiz;

    const finished = ctx.store.setQuizResult(id, {
      correct: body.correct,
      total: body.total,
      missed: body.missed,
      finishedAt: ctx.now().toISOString(),
    });
    ctx.hub.sendToMembers([finished.fromMemberId, finished.toMemberId], { type: 'quiz', quiz: finished });
    return finished;
  });
}
