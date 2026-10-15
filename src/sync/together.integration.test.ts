// TECH-DESIGN §5.2 integration tests 3 (partner quiz round trip) and 3c (duo session plan): the real
// home server in process, this phone's real sync (fetch and WebSocket over 127.0.0.1) and the real
// engine; the partner's phone is played through the server's HTTP routes and a second socket.

import { State } from 'ts-fsrs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HouseholdResponse, RegisterResponse, ServerEvent, TogetherLiveState, TogetherState } from '../../shared/api.ts';
import { joinLive, mergeLive, nextStep, openLive, OWN_STEPS, runPlanOf, sessionSteps } from '../components/together/session.ts';
import { db, dayKey, getSettings, updateSettings } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind, RolePlay, StoryEntry, UnitSpec } from '../lib/types.ts';
import { DAY_MS, getDay, weekStart } from '../srs/days.ts';
import { newCardRecord } from '../srs/scheduler.ts';
import { buildQuizPool, buildWeekPlan, type WeekPlanInput } from '../srs/together.ts';
import { createQuiz } from './client.ts';
import { startSync } from './index.ts';
import { getServerStatus, onServerEvent } from './socket.ts';
import { startLiveServer, type LiveServer } from './test-server.ts';
import { flushTogetherOutbox, onLive, postTogetherEvent, refreshTogether, sendLive, syncPartnerQuizzes } from './together.ts';

vi.mock('../lib/data.ts', async () => (await import('../srs/test-fixtures.ts')).dataMock);

let server: LiveServer;
let me: RegisterResponse;
let partner: RegisterResponse;
let stopSync: () => void;

beforeAll(async () => {
  server = await startLiveServer();
  me = await server.register('Emma');
  partner = await server.register('Ken');
  await updateSettings({
    name: 'Emma', onboarded: true, serverUrl: server.url, deviceToken: me.deviceToken, memberId: me.memberId, householdName: me.householdName,
  });
  stopSync = startSync();
  await vi.waitFor(() => expect(getServerStatus()).toBe('online'), { timeout: 5_000 });
}, 20_000);

afterAll(async () => {
  stopSync?.();
  await server?.close();
});

const isQuiz = (id: string) => (e: ServerEvent): e is Extract<ServerEvent, { type: 'quiz' }> =>
  e.type === 'quiz' && e.quiz.id === id && Boolean(e.quiz.result);

/** A Review card of an item introduced `introducedDaysAgo` days ago, due `dueIn` days from now. */
async function reviewCard(itemId: string, type: CardType, introducedDaysAgo: number, dueIn: number): Promise<CardRecord> {
  const now = Date.now();
  const kind = itemId.slice(0, itemId.indexOf(':')) as ItemKind;
  const introducedAt = new Date(now - introducedDaysAgo * DAY_MS);
  await db.items.put({ id: itemId, kind, key: itemId.slice(itemId.indexOf(':') + 1), introducedAt, via: 'lesson' });
  const due = new Date(now + dueIn * DAY_MS);
  const card: CardRecord = {
    ...newCardRecord(itemId, kind, type, introducedAt),
    state: State.Review, stability: 6, difficulty: 5, reps: 2, scheduled_days: 6,
    last_review: new Date(due.getTime() - 6 * DAY_MS), due,
  };
  await db.cards.put(card);
  return card;
}

describe('partner quiz round trip (§5.2 test 3)', () => {
  it('reschedules only the in-window card, once, however often the result arrives', async () => {
    const inWindow = await reviewCard('kanji:日', 'write', 3, 1);
    const outside = await reviewCard('word:1002', 'read', 4, 9);

    // This phone (the answerer) builds its pool and creates the quiz for the asker.
    const items = await buildQuizPool('partner');
    expect(items.map((i) => i.key).sort()).toEqual([inWindow.id, outside.id].sort());
    const quiz = await createQuiz({ toMemberId: partner.memberId, kind: 'partner', items });
    expect(quiz).toMatchObject({ fromMemberId: me.memberId, toMemberId: partner.memberId, kind: 'partner' });

    // The asker's phone posts the verdicts; the server pushes the finished quiz to this phone's socket.
    const pushed: ServerEvent[] = [];
    const offEvents = onServerEvent((e) => { if (isQuiz(quiz.id)(e)) pushed.push(e); });
    const res = await server.inject('POST', `/api/quizzes/${quiz.id}/result`, partner.deviceToken, {
      correct: 1, total: 2, missed: [outside.id],
      verdicts: [{ key: inWindow.id, verdict: 'right' }, { key: outside.id, verdict: 'wrong' }],
    });
    expect(res.statusCode).toBe(200);

    // The 'quiz' WebSocket event and a refresh deliver the result at the same time.
    await syncPartnerQuizzes();
    await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
    offEvents();
    await vi.waitFor(async () => expect((await db.partnerQuizzes.get(quiz.id))?.appliedAt).toBeInstanceOf(Date), { timeout: 5_000 });

    expect(await db.partnerQuizzes.get(quiz.id)).toMatchObject({ role: 'answerer', graded: 1, practiced: 1 });
    const logs = await db.reviewLogs.where('cardId').equals(inWindow.id).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ mode: 'partner', context: 'partner' });
    const graded = (await db.cards.get(inWindow.id))!;
    expect(graded.due.getTime()).toBeGreaterThan(inWindow.due.getTime());
    // Outside ±2 days of due: practice only, the card keeps its schedule.
    expect((await db.cards.get(outside.id))!.due).toEqual(outside.due);
    expect(await db.reviewLogs.where('cardId').equals(outside.id).count()).toBe(0);
    expect(await db.encounters.where('itemId').equals('word:1002').filter((e) => e.source === 'partner').count()).toBe(1);

    // A repeat delivery changes nothing.
    expect(await syncPartnerQuizzes()).toBe(0);
    expect(await db.reviewLogs.where('cardId').equals(inWindow.id).count()).toBe(1);
    expect((await db.cards.get(inWindow.id))!.due).toEqual(graded.due);
  });
});

describe('duo session plan (§5.2 test 3c)', () => {
  const unit = (id: number): UnitSpec =>
    ({ id, conversation: `rp-u0${id}`, grammar: [], coreWordCeiling: 100 * id, canDos: [], task: { id: `u0${id}-task`, ready: false } }) as unknown as UnitSpec;
  const story = (id: string): StoryEntry => ({ id, level: 'start', unit: 1 }) as unknown as StoryEntry;
  const today = dayKey(new Date());
  const week = weekStart(today);
  const input = (state: TogetherState | null, usedShared: string[]): WeekPlanInput => ({
    week,
    slots: [{ session: 'A', weekday: 2, time: '20:00' }],
    state,
    units: [unit(1), unit(2)],
    roleplays: [{ id: 'rp-u01' }, { id: 'rp-u02' }] as RolePlay[],
    stories: [story('st-start-01'), story('st-start-02')],
    me: { settledUnit: 1, readyStories: ['st-start-01', 'st-start-02'], coreReached: 100, grammarReached: 6 },
    usedShared: new Set(usedShared),
    seasonFinale: false,
  });
  const emptyState: TogetherState = { slots: [], goal: null, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [] };

  it("runs the opener's script, stage and story on the joiner, and credits both members once", async () => {
    // Different cached states: this phone saw unit 1's conversation finished and story 1 shared; the partner's is stale.
    const mine = runPlanOf(buildWeekPlan(input({ ...emptyState, stages: { 'rp-u01': 5 } }, ['st-start-01'])));
    const theirs = runPlanOf(buildWeekPlan(input(emptyState, [])));
    expect(mine).toEqual({ conversation: { scriptId: 'rp-u02', stage: 1 }, rolePlayId: 'rp-u02', storyId: 'st-start-02' });
    expect(theirs).not.toEqual(mine);

    const partnerPhone = await server.socket(partner.deviceToken);
    const heard: TogetherLiveState[] = [];
    const offLive = onLive((memberId, state) => { if (memberId === partner.memberId) heard.push(state); });
    try {
      // This phone opens session A and waits; the partner's phone joins from the invite.
      const steps = sessionSteps('A', mine);
      let live = openLive({ sessionId: 'duo-1', session: 'A', me: me.memberId, plan: mine, steps, waiting: true });
      expect(sendLive(live)).toBe(true);
      const invite = await partnerPhone.next((e): e is Extract<ServerEvent, { type: 'live' }> => e.type === 'live' && e.state.sessionId === 'duo-1');
      expect(invite.memberId).toBe(me.memberId);
      let joined = joinLive(invite.state);
      expect(joined.plan).toEqual(mine);
      const joinerSteps = sessionSteps('A', joined.plan!);
      expect(joinerSteps).toEqual(steps);
      expect(joined.plan).not.toEqual(theirs);

      // The joiner never sends a plan; this phone merges it and starts.
      partnerPhone.send({ type: 'live', state: { ...joined, plan: undefined } });
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), { timeout: 5_000 });
      live = mergeLive(live, heard.at(-1)!, steps, partner.memberId);
      expect(live).toMatchObject({ status: 'active', plan: mine });

      // This phone leads through every step; the joiner follows each relayed state.
      while (live.step !== 'done') {
        live = nextStep(live, steps);
        sendLive(live);
        const step = live.step;
        const relayed = await partnerPhone.next((e): e is Extract<ServerEvent, { type: 'live' }> =>
          e.type === 'live' && e.state.sessionId === 'duo-1' && e.state.step === step);
        const before = joined.step;
        joined = mergeLive(joined, relayed.state, joinerSteps, me.memberId);
        // A step each phone finishes for itself (the joiner's own smooth mark) waits for the joiner's own tap.
        if (OWN_STEPS.has(before) && joined.step === before) joined = nextStep(joined, joinerSteps);
        expect(joined.step).toBe(step);
      }
      expect(joined).toMatchObject({ status: 'done', plan: mine });
    } finally {
      offLive();
      partnerPhone.close();
    }

    // Both phones post session-done; this phone's outbox may post twice (a retry), the partner's once.
    await postTogetherEvent({ type: 'session-done', session: 'A', date: today, minutes: 15 });
    await flushTogetherOutbox();
    const posted = await server.inject('POST', '/api/together/events', partner.deviceToken, {
      clientId: 'partner-done-1', week, event: { type: 'session-done', session: 'A', date: today, minutes: 15 },
    });
    expect(posted.statusCode).toBe(201);
    const again = await server.inject('POST', '/api/together/events', partner.deviceToken, {
      clientId: 'partner-done-1', week, event: { type: 'session-done', session: 'A', date: today, minutes: 15 },
    });
    expect(again.statusCode).toBe(200);

    // One session, whoever reported it first; it counts as a minimum day for both members, and once for the quest.
    const state = (await server.inject('GET', '/api/together', me.deviceToken)).json<TogetherState>();
    expect(state.sessions.filter((s) => s.session === 'A' && s.date === today)).toHaveLength(1);
    const { quest } = (await server.inject('GET', '/api/household', partner.deviceToken)).json<HouseholdResponse>();
    expect(quest.togetherSessions).toBe(1);
    expect(quest.minimumDays).toEqual({ [me.memberId]: 1, [partner.memberId]: 1 });

    // This phone credits the session to its day once, whoever posted it and however often the state arrives.
    await refreshTogether();
    await refreshTogether();
    const day = await getDay(today);
    expect(day.together).toEqual(['A']);
    expect(day.togetherMs).toBe(15 * 60_000);
    expect(day.minimumDone).toBe(true);
    expect((await getSettings()).memberId).toBe(me.memberId);
  });
});
