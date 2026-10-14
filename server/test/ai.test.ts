import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AiCheckRequest,
  AiCheckResponse,
  AiTranslateRequest,
  HealthResponse,
  RegisterResponse,
} from '../../shared/api.ts';
import { AiError, createAnthropicAi, type AiService } from '../src/ai.ts';
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

const okCheck = { ok: true, corrected: 'ignored', tips: [], correctedRuby: '{今日|きょう}は' };
const fixCheck = {
  ok: false,
  corrected: '水を飲んだ',
  tips: [1, 2, 3, 4].map((n) => ({ original: `o${n}`, suggestion: `s${n}`, explanation: `e${n}` })),
  correctedRuby: '水を{飲|の}んだ',
};

describe('Anthropic AI service', () => {
  it('sends the request the spec asks for', async () => {
    const { client, requests } = stubbedClient(() => message([text(okCheck)]));
    const ai = createAnthropicAi({ apiKey: 'test-key', model: DEFAULT_ANTHROPIC_MODEL, client });
    const result = await ai.check({ text: '今日は', knownKanji: ['日', '今'], context: ['おはよう', '元気？'] });

    assert.deepEqual(result, { ok: true, corrected: '今日は', tips: [], correctedRuby: '{今日|きょう}は' });
    assert.equal(requests.length, 1);
    const { headers, body } = requests[0];
    assert.equal(headers.get('x-api-key'), 'test-key');
    assert.ok(headers.get('anthropic-beta')?.split(',').includes('server-side-fallback-2026-07-01'));
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 8000);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(Object.keys(body.output_config.format.schema.properties), ['ok', 'corrected', 'tips', 'correctedRuby']);
    assert.equal('betas' in body, false);
    assert.equal('thinking' in body, false);
    assert.equal('temperature' in body, false);
    assert.match(body.system, /casual/i);
    const user = body.messages[0];
    assert.equal(user.role, 'user');
    assert.match(user.content, /<message>\n今日は\n<\/message>/);
    assert.match(user.content, /日今/);
    assert.match(user.content, /おはよう\n元気？/);
  });

  it('keeps at most three tips', async () => {
    const { client } = stubbedClient(() => message([text(fixCheck)]));
    const ai = createAnthropicAi({ apiKey: 'test', model: 'm', client });
    const result = await ai.check({ text: '水を飲むだ' });
    assert.equal(result.ok, false);
    assert.equal(result.corrected, '水を飲んだ');
    assert.deepEqual(
      result.tips.map((t) => t.original),
      ['o1', 'o2', 'o3'],
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

  it('uses the fallback model’s answer when the first model hands over', async () => {
    const { client } = stubbedClient(() =>
      message([
        text('{"ok": tr'),
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-fallback' }, trigger: { type: 'refusal' } },
        text(fixCheck),
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
      for (const url of ['/api/ai/check', '/api/ai/translate']) {
        const res = await server.app.inject({
          method: 'POST',
          url,
          headers: bearer(me.deviceToken),
          payload: { text: 'こんにちは', english: 'hello' },
        });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.json(), { error: 'ai_disabled' });
      }
    });
  });

  describe('with an AI service', () => {
    const checks: AiCheckRequest[] = [];
    const translations: AiTranslateRequest[] = [];
    let fail: AiError | null = null;
    const ai: AiService = {
      async check(request) {
        if (fail) throw fail;
        checks.push(request);
        return { ok: true, corrected: request.text, tips: [], correctedRuby: request.text };
      },
      async translate(request) {
        translations.push(request);
        return { japanese: 'こんにちは', romaji: 'konnichiwa', note: '' };
      },
    };
    let server: TestServer;
    let me: RegisterResponse;

    before(async () => {
      server = await createTestServer({ ai });
      me = await server.register('Carter');
    });
    after(() => server.close());

    const check = (payload: Record<string, unknown>) =>
      server.app.inject({ method: 'POST', url: '/api/ai/check', headers: bearer(me.deviceToken), payload });

    it('reports AI as enabled', async () => {
      const res = await server.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.json<HealthResponse>().aiEnabled, true);
    });

    it('checks text, keeping the last six context lines', async () => {
      const context = Array.from({ length: 8 }, (_, i) => `line ${i}`);
      const res = await check({ text: ' 元気？ ', knownKanji: ['元', '気'], context });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json<AiCheckResponse>(), { ok: true, corrected: '元気？', tips: [], correctedRuby: '元気？' });
      assert.deepEqual(checks.at(-1)?.context, context.slice(-6));
    });

    it('translates', async () => {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/ai/translate',
        headers: bearer(me.deviceToken),
        payload: { english: 'hello' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().romaji, 'konnichiwa');
      assert.equal(translations.length, 1);
    });

    it('validates input', async () => {
      assert.equal((await check({ text: '' })).statusCode, 400);
      assert.equal((await check({ text: 'x'.repeat(1001) })).statusCode, 400);
      assert.equal((await check({ text: 'ok', knownKanji: 'abc' })).statusCode, 400);
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
