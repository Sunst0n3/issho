import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Quiz, QuizzesResponse, RegisterResponse } from '../../shared/api.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

describe('quizzes', () => {
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer();
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  const create = (token: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: '/api/quizzes', headers: bearer(token), payload });
  const submit = (token: string, id: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: `/api/quizzes/${id}/result`, headers: bearer(token), payload });
  const quizzes = async (token: string) =>
    (await server.app.inject({ method: 'GET', url: '/api/quizzes', headers: bearer(token) })).json<QuizzesResponse>();

  it('sends a quiz to a partner', async () => {
    const res = await create(carter.deviceToken, {
      toMemberId: aiko.memberId,
      items: [{ char: '水' }, { char: '火', extra: 'dropped' }],
    });
    assert.equal(res.statusCode, 201);
    const quiz = res.json<Quiz>();
    assert.equal(quiz.fromMemberId, carter.memberId);
    assert.equal(quiz.toMemberId, aiko.memberId);
    assert.deepEqual(quiz.items, [{ char: '水' }, { char: '火' }]);
    assert.equal('result' in quiz, false);
  });

  it('rejects bad recipients and items', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ toMemberId: carter.memberId, items: [{ char: '水' }] }, 'invalid_recipient'],
      [{ toMemberId: crypto.randomUUID(), items: [{ char: '水' }] }, 'invalid_recipient'],
      [{ toMemberId: aiko.memberId, items: [] }, 'invalid_request'],
      [{ toMemberId: aiko.memberId, items: Array.from({ length: 51 }, () => ({ char: '水' })) }, 'invalid_request'],
      [{ toMemberId: 'nope', items: [{ char: '水' }] }, 'invalid_request'],
      // One kanji per item: no kana, words or punctuation.
      [{ toMemberId: aiko.memberId, items: [{ char: '日' }, { char: 'あ' }] }, 'invalid_request'],
      [{ toMemberId: aiko.memberId, items: [{ char: '日本' }] }, 'invalid_request'],
      [{ toMemberId: aiko.memberId, items: [{ char: '?' }] }, 'invalid_request'],
    ];
    for (const [payload, error] of cases) {
      const res = await create(carter.deviceToken, payload);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, error);
    }
  });

  it('lists inbox and sent, newest first', async () => {
    const second = (await create(carter.deviceToken, { toMemberId: aiko.memberId, items: [{ char: '木' }] })).json<Quiz>();
    const forAiko = await quizzes(aiko.deviceToken);
    assert.equal(forAiko.sent.length, 0);
    assert.equal(forAiko.inbox.length, 2);
    assert.equal(forAiko.inbox[0].id, second.id);

    const forCarter = await quizzes(carter.deviceToken);
    assert.equal(forCarter.inbox.length, 0);
    assert.deepEqual(
      forCarter.sent.map((q) => q.id),
      forAiko.inbox.map((q) => q.id),
    );
  });

  it('caps each list at 20', async () => {
    for (let i = 0; i < 21; i++) {
      await create(aiko.deviceToken, { toMemberId: carter.memberId, items: [{ char: '人' }] });
    }
    const forCarter = await quizzes(carter.deviceToken);
    assert.equal(forCarter.inbox.length, 20);
  });

  it('records a result only from the recipient, once', async () => {
    const quiz = (await create(carter.deviceToken, {
      toMemberId: aiko.memberId,
      items: [{ char: '山' }, { char: '川' }],
    })).json<Quiz>();

    const bySender = await submit(carter.deviceToken, quiz.id, { correct: 2, total: 2, missed: [] });
    assert.equal(bySender.statusCode, 404);

    const tooMany = await submit(aiko.deviceToken, quiz.id, { correct: 3, total: 2, missed: [] });
    assert.equal(tooMany.statusCode, 400);

    const res = await submit(aiko.deviceToken, quiz.id, { correct: 1, total: 2, missed: ['川'] });
    assert.equal(res.statusCode, 200);
    const finished = res.json<Quiz>();
    assert.equal(finished.result?.correct, 1);
    assert.deepEqual(finished.result?.missed, ['川']);
    assert.ok(finished.result?.finishedAt);

    const retry = await submit(aiko.deviceToken, quiz.id, { correct: 2, total: 2, missed: [] });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), finished);

    const unknown = await submit(aiko.deviceToken, crypto.randomUUID(), { correct: 0, total: 0, missed: [] });
    assert.equal(unknown.statusCode, 404);
    const badId = await submit(aiko.deviceToken, 'not-a-uuid', { correct: 0, total: 0, missed: [] });
    assert.equal(badId.statusCode, 400);
  });

  it('asks each kanji once, and counts only its own kanji as missed', async () => {
    const res = await create(carter.deviceToken, {
      toMemberId: aiko.memberId,
      items: [{ char: '日' }, { char: '月' }, { char: '日' }],
    });
    assert.equal(res.statusCode, 201);
    const quiz = res.json<Quiz>();
    assert.deepEqual(quiz.items, [{ char: '日' }, { char: '月' }]);

    const done = await submit(aiko.deviceToken, quiz.id, { correct: 0, total: 2, missed: ['日', '日', '月', '水'] });
    assert.deepEqual(done.json<Quiz>().result?.missed, ['日', '月']);
  });
});
