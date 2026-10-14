import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RegisterRequest, RegisterResponse } from '../../../shared/api.ts';
import { generateToken, hashToken, safeEqual } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';
import { enforceLimit } from '../rate-limit.ts';

/** A member's display name, also used by the admin CLI's rename. */
export const MemberNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{C}]+$/u, 'must not contain control characters');

const RegisterSchema = z.object({
  // No length cap (the body limit bounds it): a wrong code of any length is 'invalid_code', so
  // the pairing form can say which field is wrong, and HOUSEHOLD_CODE may be as long as you like.
  householdCode: z.string(),
  name: MemberNameSchema,
}) satisfies z.ZodType<RegisterRequest>;

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/register', async (request, reply): Promise<RegisterResponse> => {
    enforceLimit(ctx.limits.register, request.ip, reply);
    const body = parseWith(RegisterSchema, request.body);
    if (!safeEqual(body.householdCode.trim(), ctx.config.householdCode)) {
      throw new HttpError(401, 'invalid_code');
    }

    const now = ctx.now();
    const existing = ctx.store.findMemberByName(body.name);
    const member = existing ?? ctx.store.createMember(body.name, now);
    const deviceToken = generateToken();
    ctx.store.addDevice(member.id, hashToken(deviceToken), now);
    request.log.info({ memberId: member.id, newMember: !existing }, 'device registered');

    // Lets partners' phones refresh their household view.
    if (!existing) ctx.hub.broadcast({ type: 'stats', memberId: member.id });

    return { deviceToken, memberId: member.id, householdName: ctx.householdName() };
  });
}
