import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TTS_MAX_CHARS, type TtsQuery } from '../../shared/api.ts';
import { currentMember } from './auth.ts';
import type { AppContext } from './context.ts';
import { HttpError, parseWith } from './errors.ts';
import { enforceLimit, RateLimiter } from './rate-limit.ts';
import { TtsError } from './tts.ts';

/** Per member: a study session plays one line every few seconds at most. */
export const TTS_CALLS_PER_MINUTE = 120;
/** The phone keeps the WAV in its own cache too. */
const CLIENT_CACHE = 'private, max-age=604800';

const TtsSchema = z.object({
  text: z.string().trim().min(1).max(TTS_MAX_CHARS),
  voice: z.enum(['f', 'm']).default('f'),
}) satisfies z.ZodType<Required<TtsQuery>, TtsQuery>;

/**
 * POST /api/tts with a JSON TtsQuery body (inside the authenticated block). The text travels in the
 * body, never the URL, so the request log (method, URL, address) never contains it, and nothing
 * here logs it either: engine failures are logged with their error code only.
 * 200 audio/wav; 503 tts_unavailable (no engine, or it is down); 400 for bad text; 429 rate_limited.
 */
export function ttsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new RateLimiter(TTS_CALLS_PER_MINUTE, 60_000);

  app.post('/api/tts', async (request, reply) => {
    const member = currentMember(request);
    if (!ctx.tts) throw new HttpError(503, 'tts_unavailable');
    enforceLimit(limiter, member.id, reply);
    const { text, voice } = parseWith(TtsSchema, request.body);
    try {
      const { wav, cached } = await ctx.tts.synthesize(text, voice);
      return reply
        .header('content-type', 'audio/wav')
        .header('cache-control', CLIENT_CACHE)
        .header('x-tts-cache', cached ? 'hit' : 'miss')
        .send(wav);
    } catch (error) {
      if (error instanceof TtsError) {
        if (error.status >= 500) request.log.warn({ code: error.code }, 'speech synthesis failed');
        throw new HttpError(error.status, error.code);
      }
      // Anything else (a disk error, say) goes to the app's error handler, which logs it without the body.
      throw error;
    }
  });
}
