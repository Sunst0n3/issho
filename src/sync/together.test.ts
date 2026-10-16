import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiCheckRequest,
  AiCheckResponse,
  Quiz,
  TogetherEventRequest,
  TogetherLiveState,
  TogetherState,
} from '../../shared/api.ts';
import { db, dayKey, getSettings, updateSettings } from '../lib/db.ts';
import type { DayRecord, OutputSentenceRecord } from '../lib/types.ts';
import { addDays } from '../srs/days.ts';
import { connectSocket, disconnectSocket } from './socket.ts';
import {
  flushPendingOutputChecks,
  flushTogetherOutbox,
  onLive,
  postTogetherEvent,
  refreshTogether,
  resetTogether,
  sendLive,
  startTogetherSync,
  syncPartnerQuizzes,
  useTogetherState,
} from './together.ts';
import { FakeSocket, installFakeSocket } from './testSocket.ts';

// ---- The engine (B), stubbed to its contract: crediting and verdicts are idempotent ----------

const engine = vi.hoisted(() => ({
  graded: 0,
  applyCalls: 0,
  completed: [] as { id: string; result: AiCheckResponse }[],
}));

vi.mock('../srs/habits.ts', async () => {
  const { db: store } = await import('../lib/db.ts');
  return {
    /** Contract (§3.1.11): togetherMs += minutes only when `session` is not yet in DayRecord(date).together. */
    creditTogetherSession: vi.fn(async (session: string, minutes: number, date: string) =>
      store.transaction('rw', store.days, async () => {
        const day = (await store.days.get(date)) as DayRecord | undefined;
        if (day?.together?.includes(session as never)) return false;
        await store.days.put({
          date, studyMs: 0, reviews: 0, correct: 0, reviewMs: 0, strandMs: 0, newItems: 0,
          newSec: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 }, goalMet: false, steps: [],
          ...day,
          togetherMs: (day?.togetherMs ?? 0) + minutes * 60_000,
          minimumDone: true,
          together: [...(day?.together ?? []), session as never],
        });
        return true;
      })),
  };
});

vi.mock('../srs/together.ts', async () => {
  const { db: store } = await import('../lib/db.ts');
  return {
    /** Contract (§3.1.14): applied once per quiz id, in one transaction. */
    applyPartnerVerdicts: vi.fn(async (quiz: Quiz) => {
      engine.applyCalls++;
      return store.transaction('rw', store.partnerQuizzes, async () => {
        const done = await store.partnerQuizzes.get(quiz.id);
        if (done?.appliedAt) return { graded: done.graded, practiced: done.practiced };
        const graded = quiz.result?.verdicts?.length ?? 0;
        engine.graded += graded;
        await store.partnerQuizzes.put({ quizId: quiz.id, role: 'answerer', createdAt: new Date(), appliedAt: new Date(), graded, practiced: 0 });
        return { graded, practiced: 0 };
      });
    }),
  };
});

vi.mock('../srs/output.ts', async () => {
  const { db: store } = await import('../lib/db.ts');
  return {
    /** Contract (§3.1.10): the outputs with check 'pending', oldest first. */
    pendingOutputChecks: async () => (await store.outputs.where('check').equals('pending').toArray())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    completeOutputCheck: async (id: string, result: AiCheckResponse) => {
      engine.completed.push({ id, result });
      await store.outputs.update(id, { check: 'done' });
      return {};
    },
    learnerAiContext: async () => ({ knownKanji: ['水'], knownGrammar: ['te-form'], register: 'plain' as const }),
  };
});

// ---- A fake home server ----------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const emptyState = (): TogetherState => ({
  slots: [], goal: null, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [],
});

function fakeServer() {
  const state = emptyState();
  const posted: TogetherEventRequest[] = [];
  const applied = new Set<string>();
  const quizzes: Quiz[] = [];
  const checks: AiCheckRequest[] = [];
  const features = { aiEnabled: true };
  const routes = {
    health: (): Response | Error | null => null,
    events: (_req: TogetherEventRequest): Response | Error | null => null,
    check: (_req: AiCheckRequest): Response | Error | null => null,
    together: (): Response | Error | null => null,
  };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://home:8787');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/health') {
      const override = routes.health();
      if (override instanceof Error) throw override;
      return override ?? json({ ok: true, version: '0.2.0', aiEnabled: features.aiEnabled, ttsEnabled: false });
    }
    if (url.pathname === '/api/together' && method === 'GET') {
      const override = routes.together();
      if (override instanceof Error) throw override;
      return override ?? json(state);
    }
    if (url.pathname === '/api/together/events') {
      const req = JSON.parse(String(init?.body)) as TogetherEventRequest;
      posted.push(req);
      const override = routes.events(req);
      if (override instanceof Error) throw override;
      if (override) return override;
      if (applied.has(req.clientId)) return json(state, 200);
      applied.add(req.clientId);
      const ev = req.event;
      // Like the server: the first session-done per session and date is kept.
      if (ev.type === 'session-done' && !state.sessions.some((s) => s.session === ev.session && s.date === ev.date)) {
        state.sessions.push({ week: req.week, session: ev.session, date: ev.date, minutes: ev.minutes, memberId: 'me' });
      }
      if (req.event.type === 'goal') state.goal = req.event.goal;
      return json(state, 201);
    }
    if (url.pathname === '/api/quizzes') {
      return json({ inbox: quizzes.filter((q) => q.toMemberId === 'me'), sent: quizzes.filter((q) => q.fromMemberId === 'me') });
    }
    if (url.pathname === '/api/ai/check') {
      const req = JSON.parse(String(init?.body)) as AiCheckRequest;
      checks.push(req);
      const override = routes.check(req);
      if (override instanceof Error) throw override;
      if (override) return override;
      return json(checkResult(req.text));
    }
    return json({ error: 'not_found' }, 404);
  });
  return { state, posted, quizzes, checks, features, routes, fetchMock };
}

function checkResult(text: string): AiCheckResponse {
  return { ok: true, issues: [], corrected: text, correctedRuby: text, diff: [], rule: '', grammarUsed: [], words: [], tips: [] };
}

let server: ReturnType<typeof fakeServer>;

beforeEach(async () => {
  await flushTogetherOutbox();
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetTogether();
  engine.graded = 0;
  engine.applyCalls = 0;
  engine.completed = [];
  installFakeSocket();
  await updateSettings({ serverUrl: 'http://home:8787', deviceToken: 'tok', memberId: 'me' });
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchMock);
});

afterEach(() => {
  disconnectSocket();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = () => db.togetherOutbox.orderBy('createdAt').toArray();

// ---- Tests ---------------------------------------------------------------------------------

describe('postTogetherEvent', () => {
  it('quarantines events after a member change and sends them only when their owner returns', async () => {
    server.routes.events = () => new TypeError('offline');
    await postTogetherEvent({ type: 'goal', goal: { text: 'private plan', targetDate: '2026-12-01' } });
    await flushTogetherOutbox();
    await updateSettings({ memberId: 'partner', deviceToken: 'partner-token' });
    server.posted.length = 0;
    server.routes.events = () => null;
    expect(await flushTogetherOutbox()).toBe(0);
    expect(server.posted).toHaveLength(0);
    expect((await rows())[0].failed).toBe('other_pairing');
    await updateSettings({ memberId: 'me', deviceToken: 'tok' });
    expect(await flushTogetherOutbox()).toBe(1);
  });

  it('does not guess the owner of legacy events', async () => {
    await db.togetherOutbox.put({ clientId: 'legacy', createdAt: new Date(), week: '2026-10-12', event: JSON.stringify({ type: 'goal', goal: { text: 'old', targetDate: '2026-12-01' } }), attempts: 0 });
    expect(await flushTogetherOutbox()).toBe(0);
    expect(server.posted).toHaveLength(0);
    expect((await rows())[0].failed).toBe('unknown_pairing');
  });
  it('queues offline, then flushes in order with the same clientIds once the server is back', async () => {
    server.routes.events = () => new TypeError('Failed to fetch');
    await postTogetherEvent({ type: 'slots', slots: [{ session: 'A', weekday: 2, time: '20:00' }] });
    await postTogetherEvent({ type: 'goal', goal: { text: 'Order at a ramen shop', targetDate: '2026-12-01' } });
    await postTogetherEvent({ type: 'session-done', session: 'A', date: '2026-10-13', minutes: 15 });
    await flushTogetherOutbox();

    const queued = await rows();
    expect(queued.map((r) => JSON.parse(r.event).type)).toEqual(['slots', 'goal', 'session-done']);
    expect(queued.some((r) => r.failed)).toBe(false);
    expect(queued[0].attempts).toBeGreaterThanOrEqual(1);
    const ids = queued.map((r) => r.clientId);
    // Never more than one attempt per flush: the first failure stops it, keeping the order.
    expect(new Set(server.posted.map((p) => p.clientId)).size).toBe(1);

    server.posted.length = 0;
    server.routes.events = () => null;
    await expect(flushTogetherOutbox()).resolves.toBe(3);
    expect(server.posted.map((p) => p.clientId)).toEqual(ids);
    expect(server.posted.map((p) => p.event.type)).toEqual(['slots', 'goal', 'session-done']);
    expect(await rows()).toEqual([]);
  });

  it('files each event under the ISO week (Monday) of its study day', async () => {
    server.routes.events = () => new TypeError('Failed to fetch');
    // Sunday 3 a.m. still belongs to Saturday's study day.
    await postTogetherEvent({ type: 'checkin', checkin: { counts: { kanji: 3, words: 9, grammar: 1, minutes: 120 } } }, new Date(2026, 9, 18, 3, 0));
    await postTogetherEvent({ type: 'capstone-done', unit: 1, date: '2026-10-19' }, new Date(2026, 9, 19, 5, 0));
    expect((await rows()).map((r) => r.week)).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('resends a delivered event whose answer was lost, with the same clientId (the server dedupes)', async () => {
    let lose = true;
    server.routes.events = () => (lose ? new TypeError('connection reset') : null);
    await postTogetherEvent({ type: 'goal', goal: { text: 'g', targetDate: '2026-12-01' } });
    await flushTogetherOutbox();
    lose = false;
    await flushTogetherOutbox();
    expect(server.posted).toHaveLength(2);
    expect(server.posted[0].clientId).toBe(server.posted[1].clientId);
  });

  it('marks an event the server refuses and goes on with the next', async () => {
    server.routes.events = (req) => (req.event.type === 'smooth' ? json({ error: 'invalid_request' }, 400) : null);
    await postTogetherEvent({ type: 'smooth', scriptId: 'rp-u01', stage: 9 as 1 });
    await postTogetherEvent({ type: 'goal', goal: { text: 'g', targetDate: '2026-12-01' } });
    await expect(flushTogetherOutbox()).resolves.toBe(1);
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0].failed).toBe('invalid_request');
    expect(server.state.goal).toMatchObject({ text: 'g' });
  });

  it('waits while unpaired', async () => {
    await updateSettings({ deviceToken: undefined });
    await postTogetherEvent({ type: 'goal', goal: { text: 'g', targetDate: '2026-12-01' } });
    await expect(flushTogetherOutbox()).resolves.toBe(0);
    expect(server.fetchMock).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });
});

describe('the household plan in Settings (V071)', () => {
  const slots = [{ session: 'A' as const, weekday: 2 as const, time: '20:00' }, { session: 'B' as const, weekday: 6 as const, time: '10:00' }];
  const goal = { text: 'Order at a ramen shop', targetDate: '2026-12-01' };

  it('mirrors the slots and goal the partner set, from a refresh and from a post', async () => {
    await updateSettings({ togetherSlots: [{ session: 'A', weekday: 5, time: '19:00' }] });
    server.state.slots.push(...slots);
    server.state.goal = goal;
    await refreshTogether();
    expect((await getSettings()).togetherSlots).toEqual(slots);
    expect((await getSettings()).sharedGoal).toEqual(goal);

    const next = { text: 'Ask for directions', targetDate: '2027-01-15' };
    await postTogetherEvent({ type: 'goal', goal: next });
    await flushTogetherOutbox();
    expect((await getSettings()).sharedGoal).toEqual(next);
  });

  it('keeps an offline edit that is still waiting to be sent, and never empties a field', async () => {
    const mine = [{ session: 'A' as const, weekday: 4 as const, time: '21:00' }];
    await updateSettings({ togetherSlots: mine, sharedGoal: goal });
    server.routes.events = () => new TypeError('Failed to fetch');
    await postTogetherEvent({ type: 'slots', slots: mine });
    await flushTogetherOutbox();
    server.state.slots.push(...slots);
    await refreshTogether();
    expect((await getSettings()).togetherSlots).toEqual(mine);
    // The server has no goal yet: Settings keep this phone's.
    expect((await getSettings()).sharedGoal).toEqual(goal);
  });
});

describe('crediting together sessions', () => {
  it('credits each member once in a duo session: two together events plus a refresh', async () => {
    const today = dayKey();
    const stop = startTogetherSync();
    connectSocket('ws://home:8787/api/ws?token=tok');
    act(() => FakeSocket.latest().accept());

    // Both phones post session-done for A; the server keeps the first (the partner's here) and
    // tells every device twice.
    server.state.sessions.push({ week: '2026-10-12', session: 'A', date: today, minutes: 15, memberId: 'partner' });
    await postTogetherEvent({ type: 'session-done', session: 'A', date: today, minutes: 15 });
    act(() => FakeSocket.latest().receive({ type: 'together' }));
    act(() => FakeSocket.latest().receive({ type: 'together' }));
    await refreshTogether();
    await waitFor(async () => expect((await db.days.get(today))?.together).toEqual(['A']));

    const day = await db.days.get(today);
    expect(day?.togetherMs).toBe(15 * 60_000);
    expect(day?.minimumDone).toBe(true);
    stop();
  });

  it('fetches again when a change is announced while an older fetch is still in flight', async () => {
    const today = dayKey();
    const stop = startTogetherSync();
    connectSocket('ws://home:8787/api/ws?token=tok');
    act(() => FakeSocket.latest().accept());
    const gets = () => server.fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith('/api/together') && (init?.method ?? 'GET') === 'GET').length;
    // Let the start-up catch-up (and its fetch) finish first.
    await vi.waitFor(() => expect(server.fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/quizzes'))).toBe(true));
    await refreshTogether();

    // A fetch leaves (the server answers it with the state of that moment, but slowly) …
    let release!: () => void;
    const answered = new Promise<void>((resolve) => { release = resolve; });
    const before = structuredClone(server.state);
    server.routes.together = () => answered.then(() => json(before)) as unknown as Response;
    const sent = gets();
    const older = refreshTogether();
    await vi.waitFor(() => expect(gets()).toBe(sent + 1));

    // … then the partner finishes session A and the server announces it.
    server.state.sessions.push({ week: '2026-10-12', session: 'A', date: today, minutes: 15, memberId: 'partner' });
    server.routes.together = () => null;
    act(() => FakeSocket.latest().receive({ type: 'together' }));
    release();
    await older;

    await waitFor(async () => expect((await db.days.get(today))?.together).toEqual(['A']));
    expect(JSON.parse(localStorage.getItem('issho.together.v1')!).state.sessions).toHaveLength(1);
    stop();
  });

  it('credits sessions dated today or yesterday only', async () => {
    const today = dayKey();
    server.state.sessions.push(
      { week: '2026-10-05', session: 'B', date: addDays(today, -2), minutes: 15, memberId: 'partner' },
      { week: '2026-10-12', session: 'C', date: addDays(today, -1), minutes: 15, memberId: 'partner' },
    );
    await refreshTogether();
    expect(await db.days.get(addDays(today, -2))).toBeUndefined();
    expect((await db.days.get(addDays(today, -1)))?.together).toEqual(['C']);
  });
});

describe('partner quiz verdicts', () => {
  const quiz = (patch: Partial<Quiz> = {}): Quiz => ({
    id: 'q1',
    kind: 'partner',
    fromMemberId: 'me',
    toMemberId: 'partner',
    createdAt: '2026-10-14T19:00:00Z',
    items: [
      { key: 'kanji:水|write', kind: 'write', prompt: 'Write the kanji for "water"', answer: '水' },
      { key: 'core:cw-0101|produce', kind: 'produce', prompt: 'thank you', answer: 'ありがとう' },
    ],
    result: {
      correct: 1, total: 2, finishedAt: '2026-10-14T19:05:00Z', missed: ['core:cw-0101|produce'],
      verdicts: [{ key: 'kanji:水|write', verdict: 'right' }, { key: 'core:cw-0101|produce', verdict: 'close' }],
    },
    ...patch,
  });

  it('applies a result arriving by WebSocket and again by refresh once', async () => {
    server.quizzes.push(quiz());
    const stop = startTogetherSync();
    connectSocket('ws://home:8787/api/ws?token=tok');
    act(() => FakeSocket.latest().accept());
    act(() => FakeSocket.latest().receive({ type: 'quiz', quiz: quiz() }));
    await Promise.all([syncPartnerQuizzes(), syncPartnerQuizzes()]);
    await waitFor(async () => expect((await db.partnerQuizzes.get('q1'))?.appliedAt).toBeInstanceOf(Date));
    await expect(syncPartnerQuizzes()).resolves.toBe(0);

    expect(engine.applyCalls).toBeGreaterThanOrEqual(1);
    expect(engine.graded).toBe(2);
    stop();
  });

  it("leaves alone quizzes this phone asked, v1 kanji quizzes and quizzes without verdicts", async () => {
    server.quizzes.push(
      quiz({ id: 'asked', fromMemberId: 'partner', toMemberId: 'me' }),
      quiz({ id: 'v1', kind: 'kanji', items: [{ char: '水' }] }),
      quiz({ id: 'open', result: undefined }),
    );
    await expect(syncPartnerQuizzes()).resolves.toBe(0);
    expect(engine.applyCalls).toBe(0);

    server.quizzes.push(quiz({ id: 'dictation', kind: 'dictation' }));
    await expect(syncPartnerQuizzes()).resolves.toBe(1);
    expect(engine.graded).toBe(2);
  });
});

describe('pending output checks', () => {
  const pendingCheck = (id: string, text: string, draft = text): OutputSentenceRecord => ({
    id,
    day: '2026-10-14',
    target: { ref: 'core:cw-0101', label: '{食|た}べる', en: 'to eat' },
    draft,
    text,
    check: 'pending',
    createdAt: new Date('2026-10-14T20:00:00Z'),
  });

  const checkStates = async () => (await db.outputs.toArray()).map((r) => [r.id, r.check]);
  const checkRequests = () => server.fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/ai/check')).length;

  it('reveals each queued check with the learner context and completes it', async () => {
    await db.outputs.bulkAdd([pendingCheck('o1', 'すしを食べた', 'すしが食べた'), pendingCheck('o2', 'みずをのむ')]);
    await expect(flushPendingOutputChecks()).resolves.toBe(2);
    expect(server.checks).toEqual([
      { knownKanji: ['水'], knownGrammar: ['te-form'], register: 'plain', text: 'すしを食べた', mode: 'reveal', target: '食べる', firstAttempt: 'すしが食べた' },
      { knownKanji: ['水'], knownGrammar: ['te-form'], register: 'plain', text: 'みずをのむ', mode: 'reveal', target: '食べる' },
    ]);
    expect(engine.completed.map((c) => c.id)).toEqual(['o1', 'o2']);
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
  });

  it('keeps checks pending while the server is unreachable or the AI is failing', async () => {
    await db.outputs.bulkAdd([pendingCheck('o1', 'すしを食べた'), pendingCheck('o2', 'みずをのむ')]);
    server.routes.health = () => new TypeError('Failed to fetch');
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(checkRequests()).toBe(0);

    server.routes.health = () => null;
    server.routes.check = () => new TypeError('Failed to fetch');
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    server.routes.check = () => json({ error: 'ai_unavailable' }, 502);
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(engine.completed).toEqual([]);
    expect(await checkStates()).toEqual([['o1', 'pending'], ['o2', 'pending']]);
  });

  it('never asks a server without AI (health aiEnabled false): its checks become unavailable', async () => {
    await db.outputs.bulkAdd([pendingCheck('o1', 'くじにがっこうにいきます'), pendingCheck('o2', 'みずをのむ')]);
    server.features.aiEnabled = false;
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(checkRequests()).toBe(0);
    expect(await checkStates()).toEqual([['o1', 'unavailable'], ['o2', 'unavailable']]);

    // Every later reconnect: nothing left to ask about, not even the health check.
    server.fetchMock.mockClear();
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("stops at 'ai_disabled' (the key was removed since the health check) and marks the rest unavailable", async () => {
    await db.outputs.bulkAdd([pendingCheck('o1', 'すしを食べた'), pendingCheck('o2', 'みずをのむ')]);
    server.routes.check = () => json({ error: 'ai_disabled' }, 503);
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(checkRequests()).toBe(1);
    expect(await checkStates()).toEqual([['o1', 'unavailable'], ['o2', 'unavailable']]);
  });

  it("treats 'ai_misconfigured' (a refused key or model) as the output step does: unavailable, not asked again", async () => {
    await db.outputs.bulkAdd([pendingCheck('o1', 'すしを食べた'), pendingCheck('o2', 'みずをのむ')]);
    server.routes.check = () => json({ error: 'ai_misconfigured' }, 503);
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(checkRequests()).toBe(1);
    expect(await checkStates()).toEqual([['o1', 'unavailable'], ['o2', 'unavailable']]);
    await expect(flushPendingOutputChecks()).resolves.toBe(0);
    expect(checkRequests()).toBe(1);
  });
});

describe('useTogetherState', () => {
  it('loads the state, caches it, and serves the cache offline', async () => {
    server.state.slots.push({ session: 'B', weekday: 4, time: '20:00' });
    const { result, unmount } = renderHook(() => useTogetherState());
    await waitFor(() => expect(result.current.state?.slots).toHaveLength(1));
    expect(result.current.offline).toBe(false);
    expect(JSON.parse(localStorage.getItem('issho.together.v1')!).state.slots).toHaveLength(1);
    unmount();

    server.routes.together = () => new TypeError('Failed to fetch');
    const again = renderHook(() => useTogetherState());
    await act(async () => { await again.result.current.refresh(); });
    expect(again.result.current.state?.slots).toHaveLength(1);
    expect(again.result.current.offline).toBe(true);
  });
});

describe('live session state', () => {
  const live: TogetherLiveState = { sessionId: 's1', session: 'A', opener: 'me', step: 'quiz', status: 'active' };

  it("sends this phone's state and hands the partner's to listeners", async () => {
    expect(sendLive(live)).toBe(false);
    const stop = startTogetherSync();
    connectSocket('ws://home:8787/api/ws?token=tok');
    act(() => FakeSocket.latest().accept());
    expect(sendLive(live)).toBe(true);
    expect(JSON.parse(FakeSocket.latest().sent.at(-1)!)).toEqual({ type: 'live', state: live });

    const seen: [string, TogetherLiveState][] = [];
    const off = onLive((memberId, state) => seen.push([memberId, state]));
    act(() => FakeSocket.latest().receive({ type: 'live', memberId: 'partner', state: { ...live, opener: 'partner', index: 2 } }));
    off();
    act(() => FakeSocket.latest().receive({ type: 'live', memberId: 'partner', state: live }));
    expect(seen).toEqual([['partner', { ...live, opener: 'partner', index: 2 }]]);
    stop();
  });
});
