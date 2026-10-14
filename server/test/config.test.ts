import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../src/config.ts';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('config', () => {
  it('requires HOUSEHOLD_CODE', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ HOUSEHOLD_CODE: '   ' }), ConfigError);
  });

  it('applies defaults', () => {
    const config = loadConfig({ HOUSEHOLD_CODE: 'secret', ANTHROPIC_API_KEY: '' });
    assert.equal(config.port, 8787);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.householdName, 'Our home');
    assert.equal(config.anthropicApiKey, null);
    assert.equal(config.anthropicModel, 'claude-opus-5-5');
    assert.equal(config.trustProxy, false);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.dataDir, path.join(SERVER_DIR, 'data'));
    assert.equal(config.staticDir, path.resolve(SERVER_DIR, '..', 'dist'));
  });

  it('reads overrides', () => {
    const config = loadConfig({
      HOUSEHOLD_CODE: 'secret',
      PORT: '9000',
      DATA_DIR: '/data',
      STATIC_DIR: '/app/dist',
      HOUSEHOLD_NAME: 'Tanaka home',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      TRUST_PROXY: 'true',
    });
    assert.equal(config.port, 9000);
    assert.equal(config.dataDir, '/data');
    assert.equal(config.staticDir, '/app/dist');
    assert.equal(config.householdName, 'Tanaka home');
    assert.equal(config.anthropicApiKey, 'sk-test');
    assert.equal(config.anthropicModel, 'claude-sonnet-5-5');
    assert.equal(config.trustProxy, true);
  });

  it('takes the reverse proxy’s addresses for TRUST_PROXY', () => {
    const trust = (TRUST_PROXY: string) => loadConfig({ HOUSEHOLD_CODE: 'secret', TRUST_PROXY }).trustProxy;
    assert.equal(trust(''), false);
    assert.equal(trust('false'), false);
    assert.equal(trust('yes'), true);
    assert.equal(trust('172.16.0.0/12, loopback'), '172.16.0.0/12,loopback');
    assert.equal(trust('10.0.0.1/255.0.0.0,::1'), '10.0.0.1/255.0.0.0,::1');
    for (const bad of ['caddy', '10.0.0.1/8/8', '172.16.0.0/12,,']) {
      assert.throws(() => trust(bad), ConfigError, bad);
    }
  });

  it('rejects a bad PORT', () => {
    for (const PORT of ['abc', '0', '70000', '80.5']) {
      assert.throws(() => loadConfig({ HOUSEHOLD_CODE: 'secret', PORT }), ConfigError, PORT);
    }
  });

  it('refuses to start the server without HOUSEHOLD_CODE', () => {
    const result = spawnSync(process.execPath, ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HOUSEHOLD_CODE is not set/);
  });
});
