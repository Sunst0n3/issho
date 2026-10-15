import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  RegisterResponse,
  TogetherEvent,
  TogetherEventRequest,
  TogetherState,
  WeeklyCheckin,
} from '../../shared/api.ts';
import type { StoredTogetherEvent } from '../src/db.ts';
import { foldTogether } from '../src/together.ts';
import { bearer, createTestServer, listen, openSocket, tick, type TestServer } from './helpers.ts';

const TODAY = '2026-10-15'; // a Thursday
const WEEK = '2026-10-12';

function fold(events: [string, TogetherEvent, string?][], members = ['m-a', 'm-b']): TogetherState {
  const stored: StoredTogetherEvent[] = events.map(([memberId, event, week], i) => ({
    id: i + 1,
    memberId,
    week: week ?? WEEK,
    createdAt: '2026-10-15T10:00:00.000Z',
    event,
  }));
  return foldTogether(stored, members, TODAY);
}

const checkin = (minutes: number, canDo?: string): WeeklyCheckin => ({
  counts: { kanji: 3, words: 10, grammar: 1, minutes },
  ...(canDo ? { canDo } : {}),
});

describe('together fold', () => {
  it('starts empty', () => {
    assert.deepEqual(fold([]), {
      slots: [],
      goal: null,
      stages: {},
      smooth: {},
      sessions: [],
      tasks: [],
      checkins: [],
      capstones: [],
    });
  });

  it('keeps the latest slots and goal', () => {
    const state = fold([
      ['m-a', { type: 'slots', slots: [{ session: 'A', weekday: 2, time: '20:00' }] }],
      ['m-a', { type: 'goal', goal: { text: 'Order dinner in Japanese', targetDate: '2026-10-31' } }],
      [
        'm-b',
        {
          type: 'slots',
          slots: [
            { session: 'A', weekday: 2, time: '20:30' },
            { session: 'B', weekday: 4, time: '20:00' },
          ],
        },
      ],
    ]);
    assert.deepEqual(state.slots.map((s) => s.time), ['20:30', '20:00']);
    assert.equal(state.goal?.text, 'Order dinner in Japanese');
  });

  it('counts the first smooth of a new script as stage 1, and advances when both marked it', () => {
    let state = fold([['m-a', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }]]);
    assert.deepEqual(state.stages, {});
    assert.deepEqual(state.smooth, { 'rp-u01': ['m-a'] });

    state = fold([
      ['m-a', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
      // A repeat from the same member changes nothing.
      ['m-a', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
      ['m-b', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
    ]);
    assert.deepEqual(state.stages, { 'rp-u01': 2 });
    assert.deepEqual(state.smooth, {});

    // A mark for a stage that isn't current (an old phone's, or a stage already passed) is ignored.
    state = fold([
      ['m-a', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
      ['m-b', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
      ['m-a', { type: 'smooth', scriptId: 'rp-u01', stage: 1 }],
      ['m-b', { type: 'smooth', scriptId: 'rp-u01', stage: 3 }],
    ]);
    assert.deepEqual(state.stages, { 'rp-u01': 2 });
    assert.deepEqual(state.smooth, {});
  });

  it('advances on one pass-and-play mark for both, up to finished', () => {
    const both = (stage: 1 | 2 | 3 | 4): [string, TogetherEvent] => ['m-a', { type: 'smooth', scriptId: 'rp-u02', stage, both: true }];
    assert.deepEqual(fold([both(1)]).stages, { 'rp-u02': 2 });
    const finished = fold([both(1), both(2), both(3), both(4), both(4)]);
    assert.deepEqual(finished.stages, { 'rp-u02': 5 });
    assert.deepEqual(finished.smooth, {});
  });

  it('lets a lone member advance alone', () => {
    assert.deepEqual(fold([['m-a', { type: 'smooth', scriptId: 'x', stage: 1 }]], ['m-a']).stages, { x: 2 });
  });

  it('records each session once per (week, session, date), the first report winning', () => {
    const state = fold([
      ['m-a', { type: 'session-done', session: 'A', date: '2026-10-13', minutes: 15 }],
      // The partner's phone reports the same session too.
      ['m-b', { type: 'session-done', session: 'A', date: '2026-10-13', minutes: 14 }],
      ['m-b', { type: 'session-done', session: 'A', date: '2026-10-14', minutes: 10 }],
      ['m-a', { type: 'session-done', session: 'monthly', date: '2026-10-11', minutes: 40 }, WEEK],
      // Older than 12 weeks: out of the window.
      ['m-a', { type: 'session-done', session: 'B', date: '2026-07-01', minutes: 15 }],
    ]);
    assert.deepEqual(state.sessions, [
      { week: '2026-10-12', session: 'A', date: '2026-10-13', minutes: 15, memberId: 'm-a' },
      { week: '2026-10-12', session: 'A', date: '2026-10-14', minutes: 10, memberId: 'm-b' },
      // Filed under the week of its date, whatever week the phone sent.
      { week: '2026-10-05', session: 'monthly', date: '2026-10-11', minutes: 40, memberId: 'm-a' },
    ]);
  });

  it('appends tasks, check-ins and capstones within their windows', () => {
    const state = fold([
      ['m-a', { type: 'task-done', taskId: 'u02-task', date: '2026-10-13', repeat: false }],
      ['m-b', { type: 'task-done', taskId: 'u02-task', date: '2026-10-13', repeat: false }],
      ['m-a', { type: 'task-done', taskId: 'u02-task', date: '2026-10-15', repeat: true }],
      ['m-a', { type: 'task-done', taskId: 'u01-task', date: '2026-08-01', repeat: false }],
      ['m-a', { type: 'checkin', checkin: checkin(90) }],
      ['m-b', { type: 'checkin', checkin: checkin(80, 'u01-a') }],
      // Saving the week's check-in again replaces that member's entry.
      ['m-a', { type: 'checkin', checkin: checkin(95) }],
      ['m-a', { type: 'checkin', checkin: checkin(70) }, '2026-03-02'],
      ['m-a', { type: 'capstone-done', unit: 3, date: '2026-10-11' }],
      ['m-b', { type: 'capstone-done', unit: 3, date: '2026-10-11' }],
    ]);
    assert.deepEqual(state.tasks, [
      { taskId: 'u02-task', date: '2026-10-13', repeat: false },
      { taskId: 'u02-task', date: '2026-10-15', repeat: true },
    ]);
    assert.deepEqual(
      state.checkins.map((c) => [c.week, c.memberId, c.checkin.counts.minutes]),
      [
        [WEEK, 'm-b', 80],
        [WEEK, 'm-a', 95],
      ],
    );
    assert.deepEqual(state.capstones, [{ unit: 3, date: '2026-10-11' }]);
  });
});

describe('together routes', () => {
  // Thursday 2026-10-15, local noon.
  const now = new Date(2026, 9, 15, 12, 0);
  let server: TestServer;
  let base: string;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer({ now: () => now });
    base = await listen(server);
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const post = (token: string, body: TogetherEventRequest | Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: '/api/together/events', headers: bearer(token), payload: body });
  const state = async (token: string) => {
    const res = await server.app.inject({ method: 'GET', url: '/api/together', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    return res.json<TogetherState>();
  };

  it('needs a paired device', async () => {
    assert.equal((await server.app.inject({ method: 'GET', url: '/api/together' })).statusCode, 401);
  });

  it('stores an event once per clientId and returns the state', async () => {
    const event: TogetherEventRequest = {
      clientId: 'c-1',
      week: WEEK,
      event: { type: 'session-done', session: 'A', date: '2026-10-15', minutes: 15 },
    };
    const first = await post(carter.deviceToken, event);
    assert.equal(first.statusCode, 201);
    assert.equal(first.json<TogetherState>().sessions.length, 1);

    // A resend from the outbox: 200 with the current state and no duplicate.
    const again = await post(carter.deviceToken, event);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), first.json());
    assert.equal(server.store.listTogetherEvents().length, 1);

    // The partner's phone reports the same session: stored, but the state still has it once.
    const partner = await post(aiko.deviceToken, { ...event, event: { ...event.event, minutes: 16 } as TogetherEvent });
    assert.equal(partner.statusCode, 201);
    assert.deepEqual((await state(aiko.deviceToken)).sessions, [
      { week: WEEK, session: 'A', date: '2026-10-15', minutes: 15, memberId: carter.memberId },
    ]);
  });

  it('advances a stage when both members mark it smooth', async () => {
    await post(carter.deviceToken, { clientId: 's-1', week: WEEK, event: { type: 'smooth', scriptId: 'rp-u01', stage: 1 } });
    assert.deepEqual((await state(carter.deviceToken)).smooth, { 'rp-u01': [carter.memberId] });
    const res = await post(aiko.deviceToken, { clientId: 's-1', week: WEEK, event: { type: 'smooth', scriptId: 'rp-u01', stage: 1 } });
    assert.deepEqual(res.json<TogetherState>().stages, { 'rp-u01': 2 });
    assert.deepEqual(res.json<TogetherState>().smooth, {});
  });

  it('files an event under the Monday of the week it names', async () => {
    await post(carter.deviceToken, { clientId: 'k-1', week: '2026-10-14', event: { type: 'checkin', checkin: checkin(60) } });
    assert.deepEqual(
      (await state(carter.deviceToken)).checkins.map((c) => c.week),
      [WEEK],
    );
  });

  it('rejects malformed events', async () => {
    const bad: Record<string, unknown>[] = [
      { clientId: 'b-1', week: WEEK, event: { type: 'unknown' } },
      { clientId: 'b-2', week: '15/10/2026', event: { type: 'goal', goal: { text: 'x', targetDate: '2026-10-31' } } },
      { clientId: '', week: WEEK, event: { type: 'goal', goal: { text: 'x', targetDate: '2026-10-31' } } },
      { clientId: 'b-3', week: WEEK, event: { type: 'smooth', scriptId: 'rp', stage: 5 } },
      { clientId: 'b-4', week: WEEK, event: { type: 'session-done', session: 'D', date: '2026-10-15', minutes: 15 } },
      { clientId: 'b-5', week: WEEK, event: { type: 'slots', slots: [{ session: 'A', weekday: 8, time: '20:00' }] } },
      { clientId: 'b-6', week: WEEK, event: { type: 'slots', slots: [{ session: 'A', weekday: 1, time: '25:00' }] } },
      { clientId: 'b-7', week: WEEK, event: { type: 'goal', goal: { text: '', targetDate: '2026-10-31' } } },
    ];
    for (const body of bad) {
      const res = await post(carter.deviceToken, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });

  it('tells every device of every member, the sender’s other devices included', async () => {
    const tablet = await server.register('carter');
    const phone = await openSocket(base, carter.deviceToken);
    const other = await openSocket(base, tablet.deviceToken);
    const partner = await openSocket(base, aiko.deviceToken);

    await post(carter.deviceToken, {
      clientId: 'g-1',
      week: WEEK,
      event: { type: 'goal', goal: { text: 'Read a menu', targetDate: '2026-11-30' } },
    });
    for (const socket of [phone, other, partner]) {
      assert.deepEqual(await socket.events.next((e) => e.type === 'together'), { type: 'together' });
    }
    // A resend is not news.
    await post(carter.deviceToken, {
      clientId: 'g-1',
      week: WEEK,
      event: { type: 'goal', goal: { text: 'Read a menu', targetDate: '2026-11-30' } },
    });
    await tick(50);
    assert.equal(partner.events.all.filter((e) => e.type === 'together').length, 1);

    await Promise.all([phone.close(), other.close(), partner.close()]);
  });
});
