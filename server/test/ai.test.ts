import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AiCanDoRequest,
  AiCanDoResponse,
  AiCheckRequest,
  AiCheckResponse,
  AiIssue,
  AiRecapRequest,
  AiRecapResponse,
  AiRolePlayRequest,
  AiRolePlayResponse,
  AiTranslateRequest,
  HealthResponse,
  RegisterResponse,
} from '../../shared/api.ts';
import {
  AiError,
  charDiff,
  createAnthropicAi,
  grammarTitlesLoader,
  locate,
  type AiService,
  type GrammarTitles,
} from '../src/ai.ts';
import { DEFAULT_ANTHROPIC_MODEL } from '../src/config.ts';
import { bearer, createTestServer, type TestServer } from './helpers.ts';

/** A real SDK client whose HTTP calls are answered locally, so its request building and parsing run for real. */
function stubbedClient(respond: (signal?: AbortSignal | null) => Response | Promise<Response>) {
  const requests: { headers: Headers; body: Record<string, any> }[] = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return respond(init?.signal);
    },
  });
  return { client, requests };
}

/** A Messages API response body. */
function message(content: unknown[], stopReason = 'end_turn'): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_ANTHROPIC_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}
const text = (value: unknown) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
const apiError = (status: number, type: string) =>
  Response.json({ type: 'error', error: { type, message: type } }, { status });

const words = [
  { surface: '今日', lemma: '今日', reading: 'きょう' },
  { surface: 'は', lemma: 'は', reading: 'は' },
];
const okReveal = {
  ok: true,
  issues: [],
  corrected: 'ignored',
  correctedRuby: '{今日|きょう}は',
  rule: '',
  grammarUsed: ['wa-desu'],
  words,
};
const issue = (n: number, quote: string, hint = `h${n}`, fix = `f${n}`) => ({
  quote,
  type: 'particle',
  uncertain: n === 2,
  hint,
  fix,
});
const fixReveal = {
  ok: false,
  issues: [issue(1, 'む'), issue(2, 'だ'), issue(3, '水')],
  corrected: '水を飲んだ',
  correctedRuby: '水を{飲|の}んだ',
  rule: 'Past tense of 飲む is 飲んだ.',
  grammarUsed: ['ta-form', 'o-object', 'passive'],
  words: [],
};

describe('Anthropic AI service', () => {
  it('sends the request the spec asks for (a request without a mode is a reveal)', async () => {
    const { client, requests } = stubbedClient(() => message([text(okReveal)]));
    const ai = createAnthropicAi({ apiKey: 'test-key', model: DEFAULT_ANTHROPIC_MODEL, client });
    const result = await ai.check({ text: '今日は', knownKanji: ['日', '今'], context: ['おはよう', '元気？'] });

    assert.deepEqual(result, {
      ok: true,
      issues: [],
      corrected: '今日は',
      correctedRuby: '{今日|きょう}は',
      diff: [{ op: 'same', text: '今日は' }],
      rule: '',
      // Not among the learner's known grammar (none was sent).
      grammarUsed: ['other'],
      words,
      tips: [],
    });
    assert.equal(requests.length, 1);
    const { headers, body } = requests[0];
    assert.equal(headers.get('x-api-key'), 'test-key');
    assert.ok(headers.get('anthropic-beta')?.split(',').includes('server-side-fallback-2026-07-01'));
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 8000);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(Object.keys(body.output_config.format.schema.properties), [
      'ok',
      'issues',
      'corrected',
      'correctedRuby',
      'rule',
      'grammarUsed',
      'words',
    ]);
    assert.equal('betas' in body, false);
    assert.equal('thinking' in body, false);
    assert.equal('temperature' in body, false);
    assert.match(body.system, /casual/i);
    const user = body.messages[0];
    assert.equal(user.role, 'user');
    assert.match(user.content, /<message>\n今日は\n<\/message>/);
    assert.match(user.content, /日今/);
    assert.match(user.content, /おはよう\n元気？/);
    assert.match(user.content, /Register: plain/);
  });

  it('prompt mode points at at most two issues and never gives the fix', async () => {
    const answer = {
      ok: false,
      issues: [
        issue(1, '駅で行く', 'Check the particle after 駅', '駅に行く'),
        issue(2, '行くだ', 'Use 行った here', '行った'),
        issue(3, 'x'),
      ],
    };
    const { client, requests } = stubbedClient(() => message([text(answer)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.check({ text: '昨日、駅で行くだ', mode: 'prompt', knownGrammar: ['wa-desu'] });

    assert.deepEqual(Object.keys(requests[0].body.output_config.format.schema.properties), ['ok', 'issues']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [
      { quote: '駅で行く', start: 3, end: 7, type: 'particle', uncertain: false, hint: 'Check the particle after 駅' },
      // The hint spelled out the fix, so it is blanked.
      { quote: '行くだ', start: 5, end: 8, type: 'particle', uncertain: true, hint: '' },
    ]);
    assert.equal(result.corrected, '');
    assert.equal(result.correctedRuby, '');
    assert.deepEqual(result.diff, []);
    assert.equal(result.rule, '');
    assert.deepEqual(result.words, []);
    assert.deepEqual(result.tips, []);
    assert.doesNotMatch(JSON.stringify(result), /駅に行く|行った/);
  });

  it('reveal mode returns the corrected text, a diff, the rule and at most two issues', async () => {
    const { client, requests } = stubbedClient(() => message([text(fixReveal)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const titles = new Map([['ta-form', 'Past tense: た form']]);
    const result = await ai.check(
      {
        text: '水を飲むだ',
        mode: 'reveal',
        firstAttempt: '水が飲むだ',
        target: '飲む',
        knownGrammar: ['ta-form', 'o-object'],
        knownWords: ['水', '飲む'],
      },
      titles,
    );
    assert.equal(result.ok, false);
    assert.equal(result.corrected, '水を飲んだ');
    assert.deepEqual(result.diff, [
      { op: 'same', text: '水を飲' },
      { op: 'del', text: 'む' },
      { op: 'ins', text: 'ん' },
      { op: 'same', text: 'だ' },
    ]);
    assert.equal(result.rule, 'Past tense of 飲む is 飲んだ.');
    assert.deepEqual(
      result.issues.map((i) => [i.quote, i.start, i.end]),
      [
        ['む', 3, 4],
        ['だ', 4, 5],
      ],
    );
    assert.deepEqual(result.tips, [
      { original: 'む', suggestion: '', explanation: 'h1' },
      { original: 'だ', suggestion: '', explanation: 'h2' },
    ]);
    // Only grammar the learner was taught keeps its id.
    assert.deepEqual(result.grammarUsed, ['ta-form', 'o-object', 'other']);

    const user = requests[0].body.messages[0].content as string;
    assert.match(user, /ta-form \(Past tense: た form\); o-object/);
    assert.match(user, /Words the learner knows: 水、飲む/);
    assert.match(user, /<first-attempt>\n水が飲むだ\n<\/first-attempt>/);
    assert.match(user, /practice for: 飲む/);
  });

  it('locates quotes and leaves a quote it cannot find unlocated', async () => {
    const answer = { ok: false, issues: [issue(1, 'ない'), issue(2, ' 駅 ')] };
    const { client } = stubbedClient(() => message([text(answer)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.check({ text: '駅へ行く', mode: 'prompt' });
    assert.deepEqual(
      result.issues.map((i) => [i.start, i.end]),
      [
        [null, null],
        [0, 1],
      ],
    );
  });

  it('translates', async () => {
    const answer = { japanese: '{愛|あい}してる', romaji: 'aishiteru', note: '' };
    const { client, requests } = stubbedClient(() => message([{ type: 'thinking', thinking: '', signature: 's' }, text(answer)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    assert.deepEqual(await ai.translate({ english: 'I love you' }), answer);
    assert.match(requests[0].body.messages[0].content, /<english>\nI love you\n<\/english>/);
    assert.match(requests[0].body.messages[0].content, /does not know any kanji/);
  });

  it('plays a role in a task', async () => {
    const answer = { reply: ' いらっしゃいませ。 ', en: 'Welcome.', done: false };
    const { client, requests } = stubbedClient(() => message([text(answer)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.rolePlay({
      taskId: 'u05-task',
      aiRole: 'cafe clerk',
      goal: 'Order two coffees',
      history: [{ speaker: 'a', text: 'すみません' }],
      knownGrammar: [],
    });
    assert.deepEqual(result, { reply: 'いらっしゃいませ。', en: 'Welcome.', done: false });
    const user = requests[0].body.messages[0].content as string;
    assert.match(user, /Your role: cafe clerk/);
    assert.match(user, /a: すみません/);
    assert.match(user, /Grammar taught so far: none yet/);
    assert.match(requests[0].body.system, /Never correct/);
  });

  it('recaps a member’s lines in at most two points', async () => {
    const point = (n: number) => ({ quote: `q${n}`, corrected: `c${n}`, rule: `r${n}`, grammarUsed: ['te-form', 'x'], words: [] });
    const { client } = stubbedClient(() => message([text({ points: [point(1), point(2), point(3)], praise: 'Nice!' })]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.recap({ goal: 'Order', lines: ['コーヒーをください'], knownGrammar: ['te-form'] });
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.points[0], { quote: 'q1', corrected: 'c1', rule: 'r1', grammarUsed: ['te-form', 'other'], words: [] });
    assert.equal(result.praise, 'Nice!');
  });

  it('checks a can-do rubric: one verdict per item, passed only when all are met', async () => {
    const run = async (met: boolean[], rubric: string[]) => {
      const { client } = stubbedClient(() => message([text({ met, feedback: 'Good start.' })]));
      const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
      return ai.canDo({ canDoId: 'u03-speak', kind: 'speak', rubric, text: 'わたしはカーターです' });
    };
    assert.deepEqual(await run([true, true], ['Says their name', 'Uses です']), {
      met: [true, true],
      passed: true,
      feedback: 'Good start.',
    });
    // A missing verdict is not met; extras are dropped.
    assert.deepEqual((await run([true], ['a', 'b'])).met, [true, false]);
    assert.equal((await run([true], ['a', 'b'])).passed, false);
    assert.deepEqual((await run([true, true, false], ['a', 'b'])).met, [true, true]);
  });

  it('uses the fallback model’s answer when the first model hands over', async () => {
    const { client } = stubbedClient(() =>
      message([
        text('{"ok": tr'),
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-fallback' }, trigger: { type: 'refusal' } },
        text(fixReveal),
      ]),
    );
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.check({ text: '水を飲むだ' });
    assert.equal(result.corrected, '水を飲んだ');
  });

  const failures: [string, () => Response, number, string][] = [
    ['a refusal with an explanation', () => message([text('I can’t help with that.')], 'refusal'), 422, 'refused'],
    ['a refusal with no content', () => message([], 'refusal'), 422, 'refused'],
    ['text that is not JSON', () => message([text('Looks good!')]), 502, 'ai_bad_output'],
    ['JSON that fails the schema', () => message([text({ ok: 'yes' })]), 502, 'ai_bad_output'],
    ['output cut off at max_tokens', () => message([text('{"ok": false, "corr')], 'max_tokens'), 502, 'ai_bad_output'],
    ['a bad API key', () => apiError(401, 'authentication_error'), 503, 'ai_misconfigured'],
    ['a key without access', () => apiError(403, 'permission_error'), 503, 'ai_misconfigured'],
    ['an unknown model', () => apiError(404, 'not_found_error'), 503, 'ai_misconfigured'],
    ['a rate limit', () => apiError(429, 'rate_limit_error'), 429, 'ai_rate_limited'],
    ['an overloaded API', () => apiError(529, 'overloaded_error'), 502, 'ai_unavailable'],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
      502,
      'ai_unavailable',
    ],
  ];

  for (const [name, respond, status, code] of failures) {
    it(`maps ${name} to ${status} ${code}`, async () => {
      const { client } = stubbedClient(respond);
      const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
      await assert.rejects(ai.check({ text: 'こんにちは' }), (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
      });
    });
  }

  it('gives up at the deadline, before the app stops waiting', async () => {
    // An API that never answers; like real fetch, the stub gives up when the request is aborted.
    const { client } = stubbedClient(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client, deadlineMs: 50 });
    const started = Date.now();
    await assert.rejects(ai.check({ text: 'こんにちは' }), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'ai_unavailable');
      return true;
    });
    assert.ok(Date.now() - started < 1000);
  });

  it('lets unexpected errors through', async () => {
    const client = {
      beta: {
        messages: {
          async parse() {
            throw new TypeError('bug');
          },
        },
      },
    } as unknown as Anthropic;
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    await assert.rejects(ai.translate({ english: 'hi' }), TypeError);
  });
});

describe('character diff', () => {
  it('merges runs and handles insertions, deletions and identical text', () => {
    assert.deepEqual(charDiff('駅で行く', '駅に行く'), [
      { op: 'same', text: '駅' },
      { op: 'del', text: 'で' },
      { op: 'ins', text: 'に' },
      { op: 'same', text: '行く' },
    ]);
    assert.deepEqual(charDiff('行く', '行きます'), [
      { op: 'same', text: '行' },
      { op: 'del', text: 'く' },
      { op: 'ins', text: 'きます' },
    ]);
    assert.deepEqual(charDiff('', 'はい'), [{ op: 'ins', text: 'はい' }]);
    assert.deepEqual(charDiff('はい', ''), [{ op: 'del', text: 'はい' }]);
    assert.deepEqual(charDiff('同じ', '同じ'), [{ op: 'same', text: '同じ' }]);
    // Reassembling either side from the ops gives the texts back.
    const ops = charDiff('きのうはがっこうへいった', 'きのう学校に行った');
    assert.equal(ops.filter((o) => o.op !== 'ins').map((o) => o.text).join(''), 'きのうはがっこうへいった');
    assert.equal(ops.filter((o) => o.op !== 'del').map((o) => o.text).join(''), 'きのう学校に行った');
  });

  it('finds a quote by its first occurrence', () => {
    assert.deepEqual(locate('ねこがねこ', 'ねこ'), { start: 0, end: 2 });
    assert.deepEqual(locate('ねこ', 'いぬ'), { start: null, end: null });
    assert.deepEqual(locate('ねこ', '  '), { start: null, end: null });
  });
});

describe('AI routes', () => {
  describe('without an API key', () => {
    let server: TestServer;
    let me: RegisterResponse;
    before(async () => {
      server = await createTestServer();
      me = await server.register('Carter');
    });
    after(() => server.close());

    it('answers 503 ai_disabled', async () => {
      for (const url of ['/api/ai/check', '/api/ai/translate', '/api/ai/roleplay', '/api/ai/recap', '/api/ai/cando']) {
        const res = await server.app.inject({
          method: 'POST',
          url,
          headers: bearer(me.deviceToken),
          payload: { text: 'こんにちは', english: 'hello' },
        });
        assert.equal(res.statusCode, 503, url);
        assert.deepEqual(res.json(), { error: 'ai_disabled' });
      }
    });

    it('still stores a report about a tip', async () => {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/ai/report',
        headers: bearer(me.deviceToken),
        payload: { kind: 'check', text: '駅で行く', note: 'で is fine here' },
      });
      assert.equal(res.statusCode, 204);
      assert.equal(server.store.listAiReports(5).length, 1);
    });
  });

  describe('with an AI service', () => {
    const checks: { request: AiCheckRequest; grammar?: GrammarTitles }[] = [];
    const translations: AiTranslateRequest[] = [];
    const rolePlays: AiRolePlayRequest[] = [];
    const recaps: AiRecapRequest[] = [];
    const canDos: AiCanDoRequest[] = [];
    let fail: AiError | null = null;
    const okResponse = (text: string): AiCheckResponse => ({
      ok: true,
      issues: [],
      corrected: text,
      correctedRuby: text,
      diff: [{ op: 'same', text }],
      rule: '',
      grammarUsed: [],
      words: [],
      tips: [],
    });
    const ai: AiService = {
      async check(request, grammar) {
        if (fail) throw fail;
        checks.push({ request, grammar });
        return okResponse(request.text);
      },
      async translate(request) {
        translations.push(request);
        return { japanese: 'こんにちは', romaji: 'konnichiwa', note: '' };
      },
      async rolePlay(request) {
        rolePlays.push(request);
        return { reply: 'いらっしゃいませ', en: 'Welcome', done: false };
      },
      async recap(request) {
        recaps.push(request);
        return { points: [], praise: 'Well done' };
      },
      async canDo(request) {
        canDos.push(request);
        return { met: request.rubric.map(() => true), passed: true, feedback: 'Great' };
      },
    };
    let server: TestServer;
    let me: RegisterResponse;
    let staticDir: string;

    before(async () => {
      // A built app with grammar titles, as the Docker image ships it.
      staticDir = await mkdtemp(path.join(tmpdir(), 'issho-static-'));
      await mkdir(path.join(staticDir, 'data', 'content'), { recursive: true });
      await writeFile(
        path.join(staticDir, 'data', 'content', 'grammar.json'),
        JSON.stringify([{ id: 'wa-desu', title: 'X は Y です' }, { id: 'ga-subject', title: 'Subject が' }]),
      );
      server = await createTestServer({ ai, staticDir });
      me = await server.register('Carter');
    });
    after(async () => {
      await server.close();
      await rm(staticDir, { recursive: true, force: true });
    });

    const post = (url: string, payload: Record<string, unknown>) =>
      server.app.inject({ method: 'POST', url, headers: bearer(me.deviceToken), payload });
    const check = (payload: Record<string, unknown>) => post('/api/ai/check', payload);

    it('reports AI as enabled', async () => {
      const res = await server.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.json<HealthResponse>().aiEnabled, true);
    });

    it('checks text, keeping the last six context lines, with the grammar titles', async () => {
      const context = Array.from({ length: 8 }, (_, i) => `line ${i}`);
      const res = await check({
        text: '元気？',
        knownKanji: ['元', '気'],
        context,
        mode: 'prompt',
        knownGrammar: ['wa-desu'],
        knownWords: ['元気'],
        register: 'plain',
        dropped: true,
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<AiCheckResponse>(), okResponse('元気？'));
      const last = checks.at(-1)!;
      assert.deepEqual(last.request.context, context.slice(-6));
      assert.equal(last.request.mode, 'prompt');
      assert.equal('dropped' in last.request, false);
      assert.equal(last.grammar?.get('wa-desu'), 'X は Y です');
    });

    it('keeps the text as sent, so issue offsets match the phone’s string', async () => {
      await check({ text: ' 元気？ ' });
      assert.equal(checks.at(-1)?.request.text, ' 元気？ ');
    });

    it('translates', async () => {
      const res = await post('/api/ai/translate', { english: 'hello' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().romaji, 'konnichiwa');
      assert.equal(translations.length, 1);
    });

    it('serves role-play, recap and can-do checks', async () => {
      const roleplay = await post('/api/ai/roleplay', {
        taskId: 'u05-task',
        aiRole: 'clerk',
        goal: 'Buy a ticket',
        history: [{ speaker: 'ai', text: 'どうぞ' }],
      });
      assert.equal(roleplay.statusCode, 200);
      assert.equal(roleplay.json<AiRolePlayResponse>().reply, 'いらっしゃいませ');
      assert.equal(rolePlays.length, 1);

      const recap = await post('/api/ai/recap', { goal: 'Buy a ticket', lines: ['きっぷをください'] });
      assert.equal(recap.statusCode, 200);
      assert.deepEqual(recap.json<AiRecapResponse>(), { points: [], praise: 'Well done' });

      const cando = await post('/api/ai/cando', { canDoId: 'u01-a', kind: 'write', rubric: ['Greets'], text: 'おはよう' });
      assert.equal(cando.statusCode, 200);
      assert.equal(cando.json<AiCanDoResponse>().passed, true);
      assert.equal(canDos.length, 1);
    });

    it('validates input', async () => {
      assert.equal((await check({ text: '' })).statusCode, 400);
      assert.equal((await check({ text: '   ' })).statusCode, 400);
      assert.equal((await check({ text: 'x'.repeat(1001) })).statusCode, 400);
      assert.equal((await check({ text: 'ok', knownKanji: 'abc' })).statusCode, 400);
      assert.equal((await check({ text: 'ok', mode: 'fix' })).statusCode, 400);
      assert.equal((await check({ text: 'ok', knownWords: Array.from({ length: 3001 }, () => 'a') })).statusCode, 400);
      const longHistory = Array.from({ length: 31 }, () => ({ speaker: 'a', text: 'はい' }));
      assert.equal((await post('/api/ai/roleplay', { taskId: 't', aiRole: 'r', goal: 'g', history: longHistory })).statusCode, 400);
      assert.equal((await post('/api/ai/recap', { goal: 'g', lines: [] })).statusCode, 400);
      assert.equal((await post('/api/ai/cando', { canDoId: 'c', kind: 'sing', rubric: ['a'], text: 'x' })).statusCode, 400);
      assert.equal((await post('/api/ai/report', { kind: 'other', text: 'x' })).statusCode, 400);
    });

    it('stores a report about a tip', async () => {
      const issue: AiIssue = { quote: '駅で', start: 0, end: 2, type: 'particle', uncertain: false, hint: 'Check で' };
      const res = await post('/api/ai/report', { kind: 'check', text: '駅で行く', issue });
      assert.equal(res.statusCode, 204);
      const [stored] = server.store.listAiReports(1);
      assert.equal(stored.memberId, me.memberId);
      assert.deepEqual(stored.report, { kind: 'check', text: '駅で行く', issue });
    });

    it('turns AI errors into JSON errors', async () => {
      fail = new AiError(422, 'refused');
      const res = await check({ text: 'こんにちは' });
      fail = null;
      assert.equal(res.statusCode, 422);
      assert.deepEqual(res.json(), { error: 'refused' });
    });

    it('limits each member to 30 calls a minute', async () => {
      let last;
      for (let i = 0; i < 31; i++) last = await check({ text: 'こんにちは' });
      assert.equal(last?.statusCode, 429);
      assert.deepEqual(last?.json(), { error: 'rate_limited' });
    });
  });
});

describe('grammar titles', () => {
  it('are read from the built app, and looked for again later when missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'issho-grammar-'));
    try {
      let clock = 0;
      const load = grammarTitlesLoader(path.join(dir, 'missing'), () => clock);
      // The repo's own public/data may exist in development; a missing build never throws.
      assert.ok(load() instanceof Map);
      const built = grammarTitlesLoader(dir, () => clock);
      await mkdir(path.join(dir, 'data', 'content'), { recursive: true });
      await writeFile(path.join(dir, 'data', 'content', 'grammar.json'), JSON.stringify([{ id: 'wa-desu', title: 'X は Y です' }]));
      clock += 61_000;
      assert.equal(built().get('wa-desu'), 'X は Y です');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
