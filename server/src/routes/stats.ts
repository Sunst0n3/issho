import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HouseholdResponse, MemberProgress, MemberStats, StatsUploadRequest } from '../../../shared/api.ts';
import { currentDevice, currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import {
  addDays,
  dayKey,
  fillDays,
  isDayKey,
  lastDays,
  mondayOf,
  questForWeek,
  questStreakWeeks,
  sharedStreak,
  type QuestHistory,
} from '../days.ts';
import { parseWith } from '../errors.ts';
import { togetherQuestHistory } from '../together.ts';

const HOUSEHOLD_DAYS = 7;
/** How far back the quest streak looks (two years of weeks). */
const QUEST_STREAK_WEEKS = 104;
/** The highest unit of the course. */
const MAX_UNIT = 25;
const count = z.number().int().min(0).max(1_000_000);
const dayKeySchema = z.string().refine(isDayKey, 'must be a YYYY-MM-DD date');

const DayStatsSchema = z
  .object({
    date: dayKeySchema,
    studyMinutes: z.number().min(0).max(24 * 60),
    reviews: count,
    correct: count,
    newItems: count,
    sessionComplete: z.boolean(),
    minimumDone: z.boolean().optional(),
    togetherMinutes: z.number().min(0).max(24 * 60).optional(),
    restToken: z.boolean().optional(),
    accuracyShared: z.boolean().optional(),
  })
  .refine((day) => day.correct <= day.reviews, { message: 'correct must not exceed reviews', path: ['correct'] });

/** Unknown fields are dropped (zod strips them), so a newer phone's extras never reach the partner. */
const ProgressSchema = z.object({
  unit: z.number().int().min(0).max(MAX_UNIT + 1),
  chapter: count,
  kanjiCanWrite: count,
  kanjiCanRead: count,
  wordsKnown: count,
  grammarKnown: count,
  hoursTotal: z.number().min(0).max(1_000_000),
  daysThisMonth: z.number().int().min(0).max(31),
  longestStreak: count,
  readyStories: z.array(z.string().min(1).max(80)).max(60),
  recentKanji: z.array(z.string().min(1).max(4)).max(20),
  recentItems: z.array(z.string().min(1).max(100)).max(20),
  settledUnit: z.number().int().min(0).max(MAX_UNIT),
  coreReached: count,
  grammarReached: count,
}) satisfies z.ZodType<MemberProgress>;

const StatsUploadSchema = z.object({
  days: z.array(DayStatsSchema).max(62),
  streak: count,
  kanjiKnown: count,
  knownKanji: z.array(z.string().min(1).max(4)).max(5000),
  /** v1 phones only. */
  phase: z.number().int().min(1).max(4).optional(),
  progress: ProgressSchema.optional(),
}) satisfies z.ZodType<StatsUploadRequest>;

export function statsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/stats', async (request) => {
    const member = currentMember(request);
    const upload = parseWith(StatsUploadSchema, request.body);
    ctx.store.saveStats(member.id, currentDevice(request), upload, ctx.now(), reportedDay(ctx, upload));
    ctx.hub.broadcast({ type: 'stats', memberId: member.id });
    return { ok: true };
  });

  app.get('/api/household', async (request): Promise<HouseholdResponse> => {
    const me = currentMember(request);
    const today = householdToday(ctx);
    const window = lastDays(today, HOUSEHOLD_DAYS);
    const listed = ctx.store.listMembers();

    const members = listed.map((member): MemberStats => {
      const summary = ctx.store.memberSummary(member.id);
      return {
        member,
        days: fillDays(window, ctx.store.dayStats(member.id, window[0], today)),
        streak: summary?.streak ?? 0,
        kanjiKnown: summary?.kanjiKnown ?? 0,
        knownKanji: summary?.knownKanji ?? [],
        phase: summary?.phase ?? 1,
        progress: summary?.progress ?? null,
        updatedAt: summary?.updatedAt ?? null,
      };
    });

    const week = mondayOf(today);
    const from = addDays(week, -7 * QUEST_STREAK_WEEKS);
    const together = togetherQuestHistory(ctx.store.listTogetherEvents());
    const history: QuestHistory = {
      members: listed.map((member) => member.id),
      minimumDates: Object.fromEntries(
        listed.map((member) => [member.id, ctx.store.minimumDates(member.id, from, addDays(week, 6))]),
      ),
      ...together,
    };

    return {
      householdName: ctx.householdName(),
      me: me.id,
      members,
      // v1 phones: a day counts when every member had a minimum day, or there was a together session.
      sharedStreak: sharedStreak(new Set([...ctx.store.daysEveryoneStudied(), ...together.togetherDates]), today),
      quest: questForWeek(history, week, today),
      questStreakWeeks: questStreakWeeks(history, week, today, QUEST_STREAK_WEEKS),
    };
  });
}

/**
 * Phones date their stats by their own clock. When the server's time zone lags theirs (TZ unset
 * in Docker means UTC), the server's today is still their yesterday, so follow the newest day a
 * phone has reported, up to one day ahead of the server.
 */
export function householdToday(ctx: AppContext): string {
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
