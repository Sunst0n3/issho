import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HouseholdResponse, MemberStats, StatsUploadRequest } from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { addDays, dayKey, fillDays, isDayKey, lastDays, sharedStreak } from '../days.ts';
import { parseWith } from '../errors.ts';

const HOUSEHOLD_DAYS = 7;
const count = z.number().int().min(0).max(1_000_000);

const DayStatsSchema = z.object({
  date: z.string().refine(isDayKey, 'must be a YYYY-MM-DD date'),
  studyMinutes: z.number().min(0).max(24 * 60),
  reviews: count,
  correct: count,
  newItems: count,
  sessionComplete: z.boolean(),
});

const StatsUploadSchema = z.object({
  days: z.array(DayStatsSchema).max(62),
  streak: count,
  kanjiKnown: count,
  knownKanji: z.array(z.string().min(1).max(4)).max(5000),
  phase: z.number().int().min(1).max(4),
}) satisfies z.ZodType<StatsUploadRequest>;

export function statsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/stats', async (request) => {
    const member = currentMember(request);
    const upload = parseWith(StatsUploadSchema, request.body);
    ctx.store.saveStats(member.id, upload, ctx.now(), reportedDay(ctx, upload));
    ctx.hub.broadcast({ type: 'stats', memberId: member.id });
    return { ok: true };
  });

  app.get('/api/household', async (request): Promise<HouseholdResponse> => {
    const me = currentMember(request);
    const today = householdToday(ctx);
    const window = lastDays(today, HOUSEHOLD_DAYS);

    const members = ctx.store.listMembers().map((member): MemberStats => {
      const summary = ctx.store.memberSummary(member.id);
      return {
        member,
        days: fillDays(window, ctx.store.dayStats(member.id, window[0], today)),
        streak: summary?.streak ?? 0,
        kanjiKnown: summary?.kanjiKnown ?? 0,
        knownKanji: summary?.knownKanji ?? [],
        phase: summary?.phase ?? 1,
        updatedAt: summary?.updatedAt ?? null,
      };
    });

    return {
      householdName: ctx.householdName(),
      me: me.id,
      members,
      sharedStreak: sharedStreak(ctx.store.daysEveryoneCompleted(), today),
    };
  });
}

/**
 * Phones date their stats by their own clock. When the server's time zone lags theirs (TZ unset
 * in Docker means UTC), the server's today is still their yesterday, so follow the newest day a
 * phone has reported, up to one day ahead of the server.
 */
function householdToday(ctx: AppContext): string {
  const serverToday = dayKey(ctx.now());
  const reported = ctx.store.newestDay(addDays(serverToday, 1));
  return reported !== undefined && reported > serverToday ? reported : serverToday;
}

/**
 * The uploading phone's study day: the newest day it sent (phones send a window ending today).
 * null when it sent none, or when its clock is clearly wrong, which would otherwise let that
 * phone's streak outrank the member's other device for weeks.
 */
function reportedDay(ctx: AppContext, upload: StatsUploadRequest): string | null {
  const newest = upload.days.reduce<string | null>((max, day) => (max === null || day.date > max ? day.date : max), null);
  return newest !== null && newest <= addDays(dayKey(ctx.now()), 1) ? newest : null;
}
