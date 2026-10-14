import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { clientErrorCode } from '../src/errors.ts';
import { precompressStatic, removeStaleCopies } from '../src/precompress.ts';
import { bearer, createTestServer, tick, type TestServer } from './helpers.ts';

describe('serving the built app', () => {
  let outside: string;
  let server: TestServer;

  before(async () => {
    outside = await mkdtemp(path.join(tmpdir(), 'issho-static-'));
    const dist = path.join(outside, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Issho</title>');
    await writeFile(path.join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(path.join(dist, '.env'), 'SECRET=dotfile');
    await writeFile(path.join(outside, 'secret.txt'), 'SECRET=outside');
    server = await createTestServer({ staticDir: dist });
  });
  after(async () => {
    await server.close();
    await rm(outside, { recursive: true, force: true });
  });

  const get = (url: string) => server.app.inject({ method: 'GET', url });

  it('serves index.html and sw.js without caching', async () => {
    for (const url of ['/', '/index.html', '/sw.js']) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['cache-control'], 'no-cache', url);
    }
  });

  it('serves hashed assets as immutable', async () => {
    const res = await get('/assets/index-abc123.js');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('falls back to index.html for app routes', async () => {
    for (const url of ['/together', '/learn/kanji/%E6%B0%B4', '/session?mode=review']) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /<title>Issho<\/title>/);
      assert.equal(res.headers['cache-control'], 'no-cache');
    }
  });

  it('404s missing files and unknown API routes as JSON', async () => {
    for (const url of ['/assets/missing.js', '/api/nope', '/api']) {
      const res = await get(url);
      assert.equal(res.statusCode, 404, url);
      assert.deepEqual(res.json(), { error: 'not_found' });
    }
    const post = await server.app.inject({ method: 'POST', url: '/together' });
    assert.equal(post.statusCode, 404);
  });

  it('never serves files outside the build or dotfiles', async () => {
    const attempts = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/.env',
    ];
    for (const url of attempts) {
      const res = await get(url);
      assert.doesNotMatch(res.body, /SECRET=/, url);
      if (res.statusCode === 403) assert.deepEqual(res.json(), { error: 'forbidden' }, url);
      assert.ok(res.statusCode === 404 || res.statusCode === 403 || res.statusCode === 400 || res.body.includes('<title>Issho'), `${url} → ${res.statusCode}`);
    }
  });
});

describe('without a built app', () => {
  it('serves only the API', async () => {
    const server = await createTestServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/' });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: 'not_found' });
    } finally {
      await server.close();
    }
  });
});

describe('compressed app files', () => {
  let outside: string;
  let dist: string;
  let server: TestServer;
  // Like words.json: big, repetitive JSON.
  const words = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, kana: 'たべる', en: 'to eat' })));

  before(async () => {
    outside = await mkdtemp(path.join(tmpdir(), 'issho-compress-'));
    dist = path.join(outside, 'dist');
    await mkdir(path.join(dist, 'data'), { recursive: true });
    await mkdir(path.join(dist, 'icons'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), `<!doctype html><title>Issho</title>${'<p>x</p>'.repeat(200)}`);
    await writeFile(path.join(dist, 'data', 'words.json'), words);
    await writeFile(path.join(dist, 'data', 'tiny.json'), '{}');
    await writeFile(path.join(dist, 'icons', 'icon.png'), Buffer.alloc(4096, 1));
    server = await createTestServer({ staticDir: dist });
  });
  after(async () => {
    await server.close();
    await rm(outside, { recursive: true, force: true });
  });

  const get = (url: string, encoding?: string) =>
    server.app.inject({ method: 'GET', url, headers: encoding ? { 'accept-encoding': encoding } : {} });

  it('writes brotli and gzip copies of text files only, once', async () => {
    assert.deepEqual(await precompressStatic(dist), { written: 4, upToDate: 0 });
    const files = (await readdir(dist, { recursive: true })).map((f) => f.split(path.sep).join('/')).sort();
    assert.deepEqual(files, [
      'data',
      'data/tiny.json',
      'data/words.json',
      'data/words.json.br',
      'data/words.json.gz',
      'icons',
      'icons/icon.png',
      'index.html',
      'index.html.br',
      'index.html.gz',
    ]);
    assert.deepEqual(await precompressStatic(dist), { written: 0, upToDate: 4 });

    // A rebuilt file gets fresh copies.
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(dist, 'data', 'words.json'), later, later);
    assert.deepEqual(await precompressStatic(dist), { written: 2, upToDate: 2 });
  });

  it('sends the encoding the browser accepts, with Vary', async () => {
    await precompressStatic(dist);
    const br = await get('/data/words.json', 'gzip, deflate, br');
    assert.equal(br.statusCode, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(String(br.headers['content-type']), /^application\/json/);
    assert.match(String(br.headers.vary), /accept-encoding/i);
    assert.equal(br.headers['cache-control'], 'no-cache');
    assert.equal(brotliDecompressSync(br.rawPayload).toString(), words);
    assert.ok(br.rawPayload.length < words.length / 5);

    const gz = await get('/data/words.json', 'gzip');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gz.rawPayload).toString(), words);

    const plain = await get('/data/words.json');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(String(plain.headers.vary), /accept-encoding/i);
    assert.equal(plain.body, words);

    // The single-page-app fallback is index.html, compressed too.
    const page = await get('/together', 'br');
    assert.equal(page.headers['content-encoding'], 'br');
    assert.match(brotliDecompressSync(page.rawPayload).toString(), /<title>Issho<\/title>/);

    const small = await get('/data/tiny.json', 'br');
    assert.equal(small.headers['content-encoding'], undefined);
    assert.equal(small.body, '{}');
  });

  it("never serves an older build's compressed copies after a new build is copied over it", async () => {
    const own = path.join(outside, 'rebuilt');
    await mkdir(path.join(own, 'assets'), { recursive: true });
    const page = (asset: string) => `<!doctype html><title>Issho</title><script src="/assets/${asset}"></script>${'<p>x</p>'.repeat(200)}`;
    await writeFile(path.join(own, 'index.html'), page('index-old.js'));
    await writeFile(path.join(own, 'assets', 'index-old.js'), 'console.log("old");'.repeat(100));
    await precompressStatic(own);

    // The new build is copied over the old one: index.html changes, index-old.js is gone.
    await writeFile(path.join(own, 'index.html'), page('index-new.js'));
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(own, 'index.html'), later, later);
    await rm(path.join(own, 'assets', 'index-old.js'));
    await writeFile(path.join(own, 'assets', 'index-new.js'), 'console.log("new");'.repeat(100));

    assert.equal(await removeStaleCopies(own), 4);
    const left = (await readdir(own, { recursive: true })).map((f) => f.split(path.sep).join('/')).sort();
    assert.deepEqual(left, ['assets', 'assets/index-new.js', 'index.html']);
    assert.equal(await removeStaleCopies(own), 0);

    // On start-up the server removes them before it answers, then compresses in the background.
    await precompressStatic(own);
    await writeFile(path.join(own, 'index.html'), page('index-newer.js'));
    const evenLater = new Date(Date.now() + 120_000);
    await utimes(path.join(own, 'index.html'), evenLater, evenLater);
    const started = await createTestServer({ staticDir: own, precompress: true });
    try {
      const res = await started.app.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'br' } });
      const body = res.headers['content-encoding'] === 'br' ? brotliDecompressSync(res.rawPayload).toString() : res.body;
      assert.match(body, /index-newer\.js/);
    } finally {
      await started.close();
    }
  });

  it('compresses in the background when the server starts', async () => {
    const own = path.join(outside, 'own');
    await mkdir(own);
    await writeFile(path.join(own, 'index.html'), `<!doctype html><title>Issho</title>${'<p>x</p>'.repeat(200)}`);
    const started = await createTestServer({ staticDir: own, precompress: true });
    try {
      const deadline = Date.now() + 3000;
      while (!(await stat(path.join(own, 'index.html.gz')).catch(() => null)) && Date.now() < deadline) await tick();
      const res = await started.app.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'br' } });
      assert.equal(res.headers['content-encoding'], 'br');
    } finally {
      await started.close();
    }
  });
});

describe('the API from another origin (Advanced: server address)', () => {
  let server: TestServer;
  before(async () => {
    server = await createTestServer();
  });
  after(() => server.close());

  const origin = 'http://localhost:8795';

  it('answers the preflight for JSON and bearer-token requests', async () => {
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: '/api/register',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
        'access-control-request-private-network': 'true',
      },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(String(res.headers['access-control-allow-methods']), /POST/);
    assert.match(String(res.headers['access-control-allow-methods']), /PATCH/);
    assert.match(String(res.headers['access-control-allow-headers']), /authorization/);
    assert.match(String(res.headers['access-control-allow-headers']), /content-type/);
    assert.equal(res.headers['access-control-allow-private-network'], 'true');
  });

  it('lets the page read answers and errors', async () => {
    const { deviceToken } = await server.register('Carter');
    const ok = await server.app.inject({ method: 'GET', url: '/api/household', headers: { origin, ...bearer(deviceToken) } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['access-control-allow-origin'], '*');
    // A 401 must be readable too, so the phone knows to pair again.
    const denied = await server.app.inject({ method: 'GET', url: '/api/household', headers: { origin, ...bearer('A'.repeat(43)) } });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers['access-control-allow-origin'], '*');
    // Never with credentials: auth is the bearer token.
    assert.equal(denied.headers['access-control-allow-credentials'], undefined);
  });

  it('leaves same-origin and non-API responses alone', async () => {
    const same = await server.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(same.headers['access-control-allow-origin'], undefined);
    const page = await server.app.inject({ method: 'OPTIONS', url: '/together', headers: { origin } });
    assert.equal(page.statusCode, 404);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  });
});

describe('error codes', () => {
  it('names 403 forbidden', () => {
    assert.equal(clientErrorCode(403), 'forbidden');
  });
});
