import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RenameMemberRequest, RenameMemberResponse, SignOutResponse } from '../../../shared/api.ts';
import { currentDevice, currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';
import { MemberNameSchema } from './register.ts';

const RenameSchema = z.object({ name: MemberNameSchema }) satisfies z.ZodType<RenameMemberRequest>;

/** The caller's own member and device. */
export function meRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The name a phone changes in its settings, so the partner sees it and pairing again finds it.
  app.patch('/api/me', async (request): Promise<RenameMemberResponse> => {
    const member = currentMember(request);
    const { name } = parseWith(RenameSchema, request.body);
    const holder = ctx.store.findMemberByName(name);
    if (holder && holder.id !== member.id) throw new HttpError(409, 'name_taken');
    if (name === member.name) return member;

    const renamed = ctx.store.renameMember(member.id, name);
    // Lets every phone (this member's other devices too) refresh its household view.
    ctx.hub.broadcast({ type: 'stats', memberId: member.id });
    return renamed;
  });

  // "Disconnect this phone": the token stops working, so a lost or handed-on phone can't sign in.
  app.post('/api/signout', async (request): Promise<SignOutResponse> => {
    const tokenHash = currentDevice(request);
    ctx.store.removeDevice(tokenHash);
    ctx.hub.closeDevice(tokenHash);
    request.log.info({ memberId: currentMember(request).id }, 'device signed out');
    return { ok: true };
  });
}
