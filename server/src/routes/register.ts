import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Member, RegisterRequest, RegisterResponse } from '../../../shared/api.ts';
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
  memberId: z.uuid().optional(),
}) satisfies z.ZodType<RegisterRequest>;

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/register', async (request, reply): Promise<RegisterResponse> => {
    enforceLimit(ctx.limits.register, request.ip, reply);
    const body = parseWith(RegisterSchema, request.body);
    if (!safeEqual(body.householdCode.trim(), ctx.config.householdCode)) {
      throw new HttpError(401, 'invalid_code');
    }

    const now = ctx.now();
    const { member, change } = findOrCreateMember(ctx, body, now);
    const deviceToken = generateToken();
    ctx.store.addDevice(member.id, hashToken(deviceToken), now);
    request.log.info({ memberId: member.id, newMember: change === 'created' }, 'device registered');

    // Lets partners' phones refresh their household view.
    if (change) ctx.hub.broadcast({ type: 'stats', memberId: member.id });

    return {
      deviceToken,
      memberId: member.id,
      householdName: ctx.householdName(),
      householdId: ctx.store.householdId(),
    };
  });
}

/**
 * Same name = same member. A phone pairing again also names the member it was before, which
 * keeps that member (renamed when the name changed meanwhile) instead of making a second one,
 * unless another member already has the name.
 */
function findOrCreateMember(
  ctx: AppContext,
  body: z.output<typeof RegisterSchema>,
  now: Date,
): { member: Member; change: 'created' | 'renamed' | null } {
  const byName = ctx.store.findMemberByName(body.name);
  const previous = body.memberId ? ctx.store.getMember(body.memberId) : undefined;
  if (previous && (!byName || byName.id === previous.id)) {
    if (previous.name === body.name) return { member: previous, change: null };
    return { member: ctx.store.renameMember(previous.id, body.name), change: 'renamed' };
  }
  if (byName) return { member: byName, change: null };
  return { member: ctx.store.createMember(body.name, now), change: 'created' };
}
