import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, dataPaths, loadConfig } from '../src/config.ts';

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
    assert.equal(config.voicevoxUrl, null);
    assert.equal(config.ttsCacheMb, 300);
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

  it('reads the speech engine settings', () => {
    const config = loadConfig({ HOUSEHOLD_CODE: 'secret', VOICEVOX_URL: ' http://voicevox:50021/ ', TTS_CACHE_MB: '50' });
    assert.equal(config.voicevoxUrl, 'http://voicevox:50021');
    assert.equal(config.ttsCacheMb, 50);
    assert.equal(loadConfig({ HOUSEHOLD_CODE: 'secret', VOICEVOX_URL: '' }).voicevoxUrl, null);
    assert.equal(loadConfig({ HOUSEHOLD_CODE: 'secret', VOICEVOX_URL: 'https://tts.lan/engine' }).voicevoxUrl, 'https://tts.lan/engine');
    assert.equal(dataPaths('/data').tts, path.join('/data', 'tts'));
  });

  it('rejects a VOICEVOX_URL that is not an http address, and a TTS_CACHE_MB out of range', () => {
    for (const VOICEVOX_URL of ['voicevox:50021', 'ftp://voicevox', 'http://voicevox:50021/?speaker=1', 'not a url']) {
      assert.throws(() => loadConfig({ HOUSEHOLD_CODE: 'secret', VOICEVOX_URL }), ConfigError, VOICEVOX_URL);
    }
    for (const TTS_CACHE_MB of ['9', '5001', 'lots', '12.5']) {
      assert.throws(() => loadConfig({ HOUSEHOLD_CODE: 'secret', TTS_CACHE_MB }), ConfigError, TTS_CACHE_MB);
    }
    assert.equal(loadConfig({ HOUSEHOLD_CODE: 'secret', TTS_CACHE_MB: '10' }).ttsCacheMb, 10);
    assert.equal(loadConfig({ HOUSEHOLD_CODE: 'secret', TTS_CACHE_MB: '5000' }).ttsCacheMb, 5000);
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
