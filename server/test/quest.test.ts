import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  DayStats,
  HouseholdResponse,
  RegisterResponse,
  StatsUploadRequest,
  TogetherEventRequest,
  TogetherSessionId,
} from '../../shared/api.ts';
import {
  addDays,
  coupleQuest,
  isoWeekday,
  lastDays,
  mondayOf,
  questForWeek,
  questStreakWeeks,
  type CoupleQuestInput,
  type QuestHistory,
} from '../src/days.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

const WEEK = '2026-10-12'; // Monday
const SUNDAY = '2026-10-18';
const week = lastDays(SUNDAY, 7);

/** The first `n` days of the week. */
const days = (n: number, from = WEEK) => new Set(lastDays(addDays(from, 6), 7).slice(0, n));

function quest(overrides: Partial<CoupleQuestInput> & { a?: number; b?: number; sessions?: TogetherSessionId[] }) {
  const { a = 5, b = 5, sessions = ['A', 'B', 'C'], ...rest } = overrides;
  return coupleQuest({
    week: WEEK,
    today: SUNDAY,
    members: ['a', 'b'],
    minimumDates: { a: days(a), b: days(b) },
    togetherDates: new Set(),
    sessionsDone: new Set(sessions),
    reserveUsedEarlierThisMonth: false,
    ...rest,
  });
}

describe('week helpers', () => {
  it('finds ISO weekdays and Mondays', () => {
    assert.deepEqual(week.map(isoWeekday), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(week.every((day) => mondayOf(day) === WEEK));
    assert.equal(mondayOf('2026-11-01'), '2026-10-26');
    assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  });
});

describe('couple quest', () => {
  it('is met with 5 + 5 minimum days and sessions A, B and C', () => {
    const q = quest({});
    assert.deepEqual(q, {
      week: WEEK,
      minimumDays: { a: 5, b: 5 },
      togetherSessions: 3,
      shortfall: 0,
      met: true,
      reserveUsed: false,
      reserveLeft: true,
      daysLeft: 1,
    });
  });

  it('uses the month’s reserve for a single shortfall (4 + 5)', () => {
    const q = quest({ a: 4 });
    assert.equal(q.shortfall, 1);
    assert.equal(q.met, true);
    assert.equal(q.reserveUsed, true);
    assert.equal(q.reserveLeft, false);
  });

  it('is not met with a second reserve in the same month', () => {
    const q = quest({ a: 4, reserveUsedEarlierThisMonth: true });
    assert.equal(q.met, false);
    assert.equal(q.reserveUsed, false);
    assert.equal(q.reserveLeft, false);
  });

  it('is not met with 4 + 4 (two shortfalls)', () => {
    const q = quest({ a: 4, b: 4 });
    assert.equal(q.shortfall, 2);
    assert.equal(q.met, false);
    assert.equal(q.reserveUsed, false);
    assert.equal(q.reserveLeft, true);
  });

  it('lets the monthly session stand in for one missing letter, never more', () => {
    assert.equal(quest({ sessions: ['A', 'C', 'monthly'] }).togetherSessions, 3);
    assert.equal(quest({ sessions: ['A', 'B', 'C', 'monthly'] }).togetherSessions, 3);
    assert.equal(quest({ sessions: ['A', 'monthly'] }).togetherSessions, 2);
    assert.equal(quest({ sessions: ['monthly'] }).togetherSessions, 1);
    assert.equal(quest({ sessions: [] }).shortfall, 3);
  });

  it('counts A twice on two dates as one session', () => {
    const history: QuestHistory = {
      members: ['a', 'b'],
      minimumDates: { a: days(7), b: days(7) },
      togetherDates: new Set(['2026-10-13', '2026-10-15']),
      sessionsByWeek: new Map([[WEEK, new Set<TogetherSessionId>(['A'])]]),
    };
    assert.equal(questForWeek(history, WEEK, SUNDAY).togetherSessions, 1);
  });

  it('counts a together date as a minimum day for both members', () => {
    const q = quest({ a: 3, b: 0, togetherDates: new Set([week[5], week[6]]) });
    assert.deepEqual(q.minimumDays, { a: 5, b: 2 });
  });

  it('counts the days left in the week, today included', () => {
    assert.equal(quest({ today: WEEK }).daysLeft, 7);
    assert.equal(quest({ today: '2026-10-15' }).daysLeft, 4);
    assert.equal(quest({ today: '2026-10-25' }).daysLeft, 0);
  });

  describe('across weeks', () => {
    // October 2026: Mondays 5, 12, 19 and 26; November starts on a Sunday, so Nov 2 is the next month's first Monday.
    const mondays = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
    const history = (perWeek: Record<string, [number, number]>): QuestHistory => {
      const a = new Set<string>();
      const b = new Set<string>();
      const sessionsByWeek = new Map<string, Set<TogetherSessionId>>();
      for (const [monday, [na, nb]] of Object.entries(perWeek)) {
        for (const day of days(na, monday)) a.add(day);
        for (const day of days(nb, monday)) b.add(day);
        sessionsByWeek.set(monday, new Set<TogetherSessionId>(['A', 'B', 'C']));
      }
      return { members: ['a', 'b'], minimumDates: { a, b }, togetherDates: new Set(), sessionsByWeek };
    };

    it('allows one reserve per calendar month, the earlier week taking it', () => {
      const h = history({ '2026-10-05': [4, 5], '2026-10-12': [5, 4], '2026-11-02': [4, 5] });
      assert.equal(questForWeek(h, '2026-10-05', '2026-10-30').reserveUsed, true);
      const second = questForWeek(h, '2026-10-12', '2026-10-30');
      assert.equal(second.met, false);
      assert.equal(second.reserveLeft, false);
      // A new month has a new reserve.
      assert.equal(questForWeek(h, '2026-11-02', '2026-11-08').met, true);
      // The week of Sep 28 belongs to September's reserve.
      assert.equal(questForWeek(history({ '2026-09-28': [4, 5], '2026-10-05': [4, 5] }), '2026-10-05', '2026-10-11').met, true);
    });

    it('counts the quest streak back from this week, or from last week while this one is open', () => {
      const h = history({
        [mondays[1]]: [5, 5],
        [mondays[2]]: [5, 5],
        [mondays[3]]: [5, 4],
        [mondays[4]]: [2, 1],
      });
      // This week (Oct 26) isn't met yet: the run up to last week counts.
      assert.equal(questStreakWeeks(h, mondays[4], '2026-10-27'), 3);
      // Once it is met, it counts too.
      const met = history({ [mondays[1]]: [5, 5], [mondays[2]]: [5, 5], [mondays[3]]: [5, 4], [mondays[4]]: [5, 5] });
      assert.equal(questStreakWeeks(met, mondays[4], '2026-11-01'), 4);
      // A week not met breaks it.
      const broken = history({ [mondays[1]]: [5, 5], [mondays[2]]: [3, 5], [mondays[3]]: [5, 5] });
      assert.equal(questStreakWeeks(broken, mondays[3], '2026-10-25'), 1);
      assert.equal(questStreakWeeks(history({}), mondays[3], '2026-10-25'), 0);
    });
  });
});

describe('quest in the household', () => {
  // Sunday 2026-10-18, local noon.
  const now = new Date(2026, 9, 18, 12, 0);
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer({ now: () => now });
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const v2Day = (date: string, minimumDone: boolean): DayStats => ({
    date,
    studyMinutes: 20,
    reviews: 30,
    correct: 0,
    newItems: 4,
    sessionComplete: false,
    minimumDone,
    togetherMinutes: 0,
    restToken: false,
    accuracyShared: false,
  });
  const upload = (token: string, minimumDays: number) => {
    const body: StatsUploadRequest = {
      days: week.map((date, i) => v2Day(date, i < minimumDays)),
      streak: minimumDays,
      kanjiKnown: 0,
      knownKanji: [],
    };
    return server.app.inject({ method: 'POST', url: '/api/stats', headers: bearer(token), payload: body });
  };
  const session = (token: string, clientId: string, session: TogetherSessionId, date: string) => {
    const body: TogetherEventRequest = { clientId, week: WEEK, event: { type: 'session-done', session, date, minutes: 15 } };
    return server.app.inject({ method: 'POST', url: '/api/together/events', headers: bearer(token), payload: body });
  };
  const household = async () =>
    (await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(carter.deviceToken) })).json<HouseholdResponse>();

  it('is met with 5 and 4 minimum days plus three sessions, using the reserve', async () => {
    assert.equal((await upload(carter.deviceToken, 5)).statusCode, 200);
    assert.equal((await upload(aiko.deviceToken, 4)).statusCode, 200);
    let res = await household();
    assert.equal(res.quest.week, WEEK);
    assert.equal(res.quest.met, false);
    assert.equal(res.quest.daysLeft, 1);

    // Sessions on days both already counted, so the minimum days stay 5 and 4.
    await session(carter.deviceToken, 'a', 'A', week[0]);
    await session(aiko.deviceToken, 'b', 'B', week[1]);
    await session(carter.deviceToken, 'c', 'C', week[2]);
    res = await household();
    assert.deepEqual(res.quest.minimumDays, { [carter.memberId]: 5, [aiko.memberId]: 4 });
    assert.equal(res.quest.togetherSessions, 3);
    assert.equal(res.quest.met, true);
    assert.equal(res.quest.reserveUsed, true);
    assert.equal(res.questStreakWeeks, 1);
  });

  it('keeps the v1 shared streak, counting minimum days and together days', async () => {
    const res = await household();
    // Both had minimum days Mon–Thu; Friday on, Aiko didn't (4 days), and nothing was done Sunday yet.
    assert.equal(res.sharedStreak, 0);
    // A together session on Friday and Saturday counts for both.
    await session(aiko.deviceToken, 'd', 'A', week[4]);
    await session(aiko.deviceToken, 'e', 'B', week[5]);
    assert.equal((await household()).sharedStreak, 6);
  });
});
