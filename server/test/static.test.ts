import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTestServer, type TestServer } from './helpers.ts';

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
