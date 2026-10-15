import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  DayStats,
  HouseholdResponse,
  MemberProgress,
  MemberStats,
  RegisterResponse,
  StatsUploadRequest,
} from '../../shared/api.ts';
import { mergeProgress } from '../src/db.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

const progress = (overrides: Partial<MemberProgress> = {}): MemberProgress => ({
  unit: 3,
  chapter: 2,
  kanjiCanWrite: 20,
  kanjiCanRead: 25,
  wordsKnown: 140,
  grammarKnown: 9,
  hoursTotal: 12.5,
  daysThisMonth: 11,
  longestStreak: 9,
  readyStories: ['st-l0-01', 'st-l0-02'],
  recentKanji: ['水', '火'],
  recentItems: ['kanji:水', 'core:cw-0042', 'grammar:te-form'],
  settledUnit: 2,
  coreReached: 120,
  grammarReached: 9,
  ...overrides,
});

const v2Day = (date: string, overrides: Partial<DayStats> = {}): DayStats => ({
  date,
  studyMinutes: 25,
  reviews: 40,
  correct: 0,
  newItems: 6,
  sessionComplete: false,
  minimumDone: true,
  togetherMinutes: 0,
  restToken: false,
  accuracyShared: false,
  ...overrides,
});

describe('v2 stats', () => {
  // Thursday 2026-10-15, local noon.
  const now = new Date(2026, 9, 15, 12, 0);
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer({ now: () => now });
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const upload = (token: string, body: StatsUploadRequest | Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: '/api/stats', headers: bearer(token), payload: body });
  const memberStats = async (memberId: string): Promise<MemberStats> => {
    const res = await server.app.inject({ method: 'GET', url: '/api/household', headers: bearer(aiko.deviceToken) });
    assert.equal(res.statusCode, 200);
    return res.json<HouseholdResponse>().members.find((m) => m.member.id === memberId)!;
  };

  it('stores the v2 day fields and the progress summary, with no phase', async () => {
    const res = await upload(carter.deviceToken, {
      days: [
        v2Day('2026-10-14', { togetherMinutes: 15.5, sessionComplete: true }),
        v2Day('2026-10-15', { minimumDone: false, restToken: true, correct: 30, accuracyShared: true }),
      ],
      streak: 4,
      kanjiKnown: 2,
      knownKanji: ['水', '火'],
      progress: progress(),
    });
    assert.equal(res.statusCode, 200);

    const carterStats = await memberStats(carter.memberId);
    assert.equal(carterStats.phase, 1);
    assert.deepEqual(carterStats.progress, progress());
    assert.deepEqual(carterStats.days.at(-2), v2Day('2026-10-14', { togetherMinutes: 15.5, sessionComplete: true }));
    assert.deepEqual(
      carterStats.days.at(-1),
      v2Day('2026-10-15', { minimumDone: false, restToken: true, correct: 30, accuracyShared: true }),
    );
    // Members whose phones sent no summary yet.
    assert.equal((await memberStats(aiko.memberId)).progress, null);
  });

  it('merges a member’s devices with the largest value per day', async () => {
    let clock = now.getTime();
    // Each request a second later, so the uploads are ordered.
    const own = await createTestServer({ now: () => new Date((clock += 1000)) });
    try {
      const phone = await own.register('Ken');
      const tablet = await own.register('ken');
      const send = (device: RegisterResponse, body: StatsUploadRequest) =>
        own.app.inject({ method: 'POST', url: '/api/stats', headers: bearer(device.deviceToken), payload: body });
      await send(phone, {
        days: [v2Day('2026-10-15', { minimumDone: false, togetherMinutes: 10, correct: 0 })],
        streak: 3,
        kanjiKnown: 1,
        knownKanji: ['水'],
        progress: progress({ unit: 3, recentKanji: ['水'], recentItems: ['kanji:水'] }),
      });
      await send(tablet, {
        days: [v2Day('2026-10-15', { minimumDone: true, togetherMinutes: 4, restToken: true, correct: 12, accuracyShared: true })],
        streak: 3,
        kanjiKnown: 1,
        knownKanji: ['火'],
        progress: progress({ unit: 4, settledUnit: 1, recentKanji: ['火'], recentItems: ['kanji:火'] }),
      });
      const res = await own.app.inject({ method: 'GET', url: '/api/household', headers: bearer(phone.deviceToken) });
      const ken = res.json<HouseholdResponse>().members[0];
      assert.deepEqual(
        ken.days.at(-1),
        v2Day('2026-10-15', { minimumDone: true, togetherMinutes: 10, restToken: true, correct: 12, accuracyShared: true }),
      );
      assert.equal(ken.progress?.unit, 4);
      assert.equal(ken.progress?.settledUnit, 2);
      // The newest upload's lists first.
      assert.deepEqual(ken.progress?.recentKanji, ['火', '水']);
    } finally {
      await own.close();
    }
  });

  it('reads a v1 phone’s completed session as its minimum day', async () => {
    const own = await createTestServer({ now: () => now });
    try {
      const old = await own.register('Ken');
      await own.app.inject({
        method: 'POST',
        url: '/api/stats',
        headers: bearer(old.deviceToken),
        payload: {
          days: [
            { date: '2026-10-14', studyMinutes: 10, reviews: 5, correct: 5, newItems: 1, sessionComplete: true },
            { date: '2026-10-15', studyMinutes: 3, reviews: 2, correct: 2, newItems: 0, sessionComplete: false },
          ],
          streak: 1,
          kanjiKnown: 0,
          knownKanji: [],
          phase: 2,
        },
      });
      const res = await own.app.inject({ method: 'GET', url: '/api/household', headers: bearer(old.deviceToken) });
      const ken = res.json<HouseholdResponse>().members[0];
      assert.equal(ken.phase, 2);
      assert.deepEqual(
        ken.days.slice(-2).map((d) => [d.date, d.minimumDone]),
        [
          ['2026-10-14', true],
          ['2026-10-15', false],
        ],
      );
      assert.equal(res.json<HouseholdResponse>().sharedStreak, 1);
    } finally {
      await own.close();
    }
  });

  it('validates the v2 fields', async () => {
    const valid: StatsUploadRequest = { days: [], streak: 0, kanjiKnown: 0, knownKanji: [], progress: progress() };
    assert.equal((await upload(carter.deviceToken, valid)).statusCode, 200);
    const invalid: Record<string, unknown>[] = [
      { ...valid, progress: progress({ recentItems: Array.from({ length: 21 }, (_, i) => `kanji:${i}`) }) },
      { ...valid, progress: progress({ recentKanji: Array.from({ length: 21 }, () => '水') }) },
      { ...valid, progress: progress({ readyStories: Array.from({ length: 61 }, (_, i) => `st-${i}`) }) },
      { ...valid, progress: progress({ settledUnit: 26 }) },
      { ...valid, progress: progress({ coreReached: -1 }) },
      { ...valid, progress: { unit: 1 } },
      { ...valid, days: [v2Day('2026-10-15', { togetherMinutes: -1 })] },
      { ...valid, days: [{ ...v2Day('2026-10-15'), restToken: 'yes' }] },
      { ...valid, days: Array.from({ length: 63 }, () => v2Day('2026-10-15')) },
    ];
    for (const body of invalid) {
      assert.equal((await upload(carter.deviceToken, body)).statusCode, 400, JSON.stringify(body).slice(0, 120));
    }
  });

  it('drops fields it does not know', async () => {
    await upload(carter.deviceToken, {
      days: [],
      streak: 0,
      kanjiKnown: 0,
      knownKanji: [],
      progress: { ...progress(), errors: 12 },
    });
    assert.equal('errors' in (await memberStats(carter.memberId)).progress!, false);
  });
});

describe('mergeProgress', () => {
  it('is null without summaries and keeps the list caps', () => {
    assert.equal(mergeProgress([]), null);
    const a = progress({ recentItems: Array.from({ length: 20 }, (_, i) => `a:${i}`), hoursTotal: 3 });
    const b = progress({ recentItems: Array.from({ length: 20 }, (_, i) => `b:${i}`), hoursTotal: 7 });
    const merged = mergeProgress([a, b])!;
    assert.equal(merged.recentItems.length, 20);
    assert.equal(merged.recentItems[0], 'a:0');
    assert.equal(merged.hoursTotal, 7);
  });
});
