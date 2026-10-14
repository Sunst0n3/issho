import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { DayStats, HouseholdResponse, RegisterResponse, StatsUploadRequest } from '../../shared/api.ts';
import { addDays, dayKey, emptyDay, fillDays, isDayKey, lastDays, sharedStreak } from '../src/days.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

describe('day helpers', () => {
  it('rolls the study day over at 4 a.m. local time', () => {
    assert.equal(dayKey(new Date(2026, 9, 14, 3, 59)), '2026-10-13');
    assert.equal(dayKey(new Date(2026, 9, 14, 4, 0)), '2026-10-14');
  });

  it('does calendar arithmetic across months and years', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('validates day keys', () => {
    assert.equal(isDayKey('2026-10-14'), true);
    assert.equal(isDayKey('2026-02-30'), false);
    assert.equal(isDayKey('2026-1-4'), false);
  });

  it('builds a 7-day window, oldest first, with zeros for missing days', () => {
    const window = lastDays('2026-10-14', 7);
    assert.deepEqual(window, [
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
    const studied: DayStats = {
      date: '2026-10-12',
      studyMinutes: 12,
      reviews: 40,
      correct: 35,
      newItems: 4,
      sessionComplete: true,
    };
    const days = fillDays(window, [studied]);
    assert.equal(days.length, 7);
    assert.deepEqual(days[4], studied);
    assert.deepEqual(days[0], {
      date: '2026-10-08',
      studyMinutes: 0,
      reviews: 0,
      correct: 0,
      newItems: 0,
      sessionComplete: false,
    });
  });

  it('counts the shared streak ending today or yesterday', () => {
    const today = '2026-10-14';
    assert.equal(sharedStreak(new Set(), today), 0);
    assert.equal(sharedStreak(new Set(['2026-10-12', '2026-10-13', '2026-10-14']), today), 3);
    // Nobody has finished today yet: the run up to yesterday still counts.
    assert.equal(sharedStreak(new Set(['2026-10-12', '2026-10-13']), today), 2);
    // A gap yesterday breaks it.
    assert.equal(sharedStreak(new Set(['2026-10-11', '2026-10-12']), today), 0);
    assert.equal(sharedStreak(new Set(['2026-10-10', '2026-10-12', '2026-10-13', '2026-10-14']), today), 3);
  });
});

describe('stats and household', () => {
  const now = new Date(2026, 9, 14, 12, 0); // local noon, study day 2026-10-14
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  const day = (date: string, sessionComplete: boolean, reviews = 10): DayStats => ({
    date,
    studyMinutes: 8.5,
    reviews,
    correct: reviews - 1,
    newItems: 3,
    sessionComplete,
  });
  const upload = (token: string, body: StatsUploadRequest) =>
    server.app.inject({ method: 'POST', url: '/api/stats', headers: bearer(token), payload: body });
  const household = async (token: string) => {
    const res = await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    return res.json<HouseholdResponse>();
  };

  before(async () => {
    server = await createTestServer({ now: () => now });
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  it('fills members without stats with zeros', async () => {
    const res = await household(carter.deviceToken);
    assert.equal(res.householdName, 'Our home');
    assert.equal(res.me, carter.memberId);
    assert.equal(res.sharedStreak, 0);
    assert.deepEqual(
      res.members.map((m) => m.member.name),
      ['Carter', 'Aiko'],
    );
    for (const member of res.members) {
      assert.equal(member.days.length, 7);
      assert.equal(member.days[0].date, '2026-10-08');
      assert.equal(member.days[6].date, '2026-10-14');
      assert.ok(member.days.every((d) => d.reviews === 0 && !d.sessionComplete));
      assert.equal(member.streak, 0);
      assert.equal(member.phase, 1);
      assert.deepEqual(member.knownKanji, []);
      assert.equal(member.updatedAt, null);
    }
  });

  it('stores uploads and computes the shared streak', async () => {
    const carterUpload = await upload(carter.deviceToken, {
      days: [day('2026-10-11', true), day('2026-10-12', true), day('2026-10-13', true), day('2026-10-14', true)],
      streak: 4,
      kanjiKnown: 3,
      knownKanji: ['日', '月', '水', '水'],
      phase: 2,
    });
    assert.equal(carterUpload.statusCode, 200);
    assert.deepEqual(carterUpload.json(), { ok: true });

    // Aiko missed the 11th and hasn't studied today yet.
    await upload(aiko.deviceToken, {
      days: [day('2026-10-11', false), day('2026-10-12', true), day('2026-10-13', true)],
      streak: 2,
      kanjiKnown: 1,
      knownKanji: ['日'],
      phase: 1,
    });

    let res = await household(aiko.deviceToken);
    assert.equal(res.me, aiko.memberId);
    assert.equal(res.sharedStreak, 2);
    const carterStats = res.members.find((m) => m.member.id === carter.memberId)!;
    assert.equal(carterStats.streak, 4);
    assert.equal(carterStats.phase, 2);
    assert.deepEqual(carterStats.knownKanji, ['日', '月', '水']);
    assert.equal(carterStats.updatedAt, now.toISOString());
    assert.deepEqual(carterStats.days[6], day('2026-10-14', true));
    assert.deepEqual(carterStats.days[2], emptyDay('2026-10-10'));

    // Aiko finishes today; re-uploading a day replaces it.
    await upload(aiko.deviceToken, {
      days: [day('2026-10-14', true, 25)],
      streak: 3,
      kanjiKnown: 2,
      knownKanji: ['日', '月'],
      phase: 1,
    });
    res = await household(carter.deviceToken);
    assert.equal(res.sharedStreak, 3);
    const aikoStats = res.members.find((m) => m.member.id === aiko.memberId)!;
    assert.equal(aikoStats.days[6].reviews, 25);
    assert.equal(aikoStats.days[3].sessionComplete, false);
  });

  it('follows the phones when their study day is ahead of the server’s', async () => {
    // Server on UTC, phones in Tokyo: at 08:00 there the phones are on the 15th, the server on the 14th.
    const own = await createTestServer({ now: () => now });
    try {
      const a = await own.register('Carter');
      const b = await own.register('Aiko');
      const send = (token: string, days: DayStats[]) =>
        own.app.inject({
          method: 'POST',
          url: '/api/stats',
          headers: bearer(token),
          payload: { days, streak: days.length, kanjiKnown: 0, knownKanji: [], phase: 1 },
        });
      await send(a.deviceToken, [day('2026-10-13', true), day('2026-10-14', true), day('2026-10-15', true)]);
      await send(b.deviceToken, [day('2026-10-14', true), day('2026-10-15', true)]);
      // A phone with its clock set weeks ahead doesn't drag the window along.
      await send(b.deviceToken, [day('2026-11-30', false)]);

      const res = (
        await own.app.inject({ method: 'GET', url: '/api/household', headers: bearer(a.deviceToken) })
      ).json<HouseholdResponse>();
      assert.equal(res.sharedStreak, 2);
      for (const member of res.members) {
        assert.equal(member.days[6].date, '2026-10-15');
        assert.equal(member.days[6].sessionComplete, true);
      }
    } finally {
      await own.close();
    }
  });

  it('validates uploads', async () => {
    const valid: StatsUploadRequest = { days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1 };
    const invalid: Record<string, unknown>[] = [
      { ...valid, days: [{ ...day('2026-10-14', true), date: '14/10/2026' }] },
      { ...valid, days: [{ ...day('2026-10-14', true), reviews: -1 }] },
      { ...valid, phase: 7 },
      { ...valid, knownKanji: 'abc' },
      { ...valid, streak: undefined },
    ];
    for (const body of invalid) {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/stats',
        headers: bearer(carter.deviceToken),
        payload: body,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });
});
