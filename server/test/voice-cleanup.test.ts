import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { buildApp } from '../src/app.ts';
import { dataPaths, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { cleanupOrphanedVoice, startVoiceCleanup, VOICE_ORPHAN_AGE_MS } from '../src/voice-cleanup.ts';
import { HOUSEHOLD_CODE, tick, WEBM } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

describe('voice cleanup', () => {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let dataDir: string;
  let voiceDir: string;
  let store: Store;
  let memberId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'issho-voice-'));
    voiceDir = dataPaths(dataDir).voice;
    await mkdir(voiceDir);
    store = new Store(':memory:');
    memberId = store.createMember('Carter', ago(48 * HOUR)).id;
  });
  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A recording as the voice route stores it; `sent` also posts a message that plays it. */
  async function recording(createdAt: Date, sent: boolean): Promise<string> {
    const id = randomUUID();
    const fileName = `${id}.webm`;
    await writeFile(path.join(voiceDir, fileName), WEBM);
    store.insertVoice({ id, memberId, contentType: 'audio/webm', fileName, size: WEBM.length, createdAt: createdAt.toISOString() });
    if (sent) {
      store.insertMessage({ clientId: id, memberId, createdAt: createdAt.toISOString(), kind: 'voice', text: '', audioId: id });
    }
    return fileName;
  }

  /** A file on disk with no database row, last modified at `modified`. */
  async function stray(name: string, modified: Date): Promise<string> {
    const file = path.join(voiceDir, name);
    await writeFile(file, WEBM);
    await utimes(file, modified, modified);
    return name;
  }

  const files = async () => (await readdir(voiceDir)).sort();

  it('deletes recordings and stray files older than a day that no message uses', async () => {
    const abandoned = await recording(ago(VOICE_ORPHAN_AGE_MS + HOUR), false);
    const sent = await recording(ago(30 * 24 * HOUR), true);
    const pending = await recording(ago(VOICE_ORPHAN_AGE_MS - HOUR), false);
    const oldStray = await stray(`${randomUUID()}.m4a`, ago(2 * VOICE_ORPHAN_AGE_MS));
    const newStray = await stray(`${randomUUID()}.ogg`, ago(HOUR));
    const notOurs = await stray('notes.txt', ago(2 * VOICE_ORPHAN_AGE_MS));

    assert.equal(await cleanupOrphanedVoice(store, voiceDir, now), 2);

    assert.deepEqual(await files(), [sent, pending, newStray, notOurs].sort());
    const idOf = (fileName: string) => fileName.split('.')[0];
    assert.equal(store.getVoice(idOf(abandoned)), undefined);
    assert.ok(store.getVoice(idOf(sent)));
    assert.ok(store.getVoice(idOf(pending)));
    assert.ok(!(await files()).includes(oldStray));

    // Nothing left to do the second time.
    assert.equal(await cleanupOrphanedVoice(store, voiceDir, now), 0);
  });

  it('copes with a row whose file is already gone', async () => {
    const fileName = await recording(ago(2 * VOICE_ORPHAN_AGE_MS), false);
    await rm(path.join(voiceDir, fileName));
    assert.equal(await cleanupOrphanedVoice(store, voiceDir, now), 0);
    assert.equal(store.voiceFileNames().size, 0);
  });

  it('runs when the server starts', async () => {
    const leftover = await stray(`${randomUUID()}.webm`, ago(2 * VOICE_ORPHAN_AGE_MS));
    const config = loadConfig({ HOUSEHOLD_CODE, DATA_DIR: dataDir, STATIC_DIR: path.join(dataDir, 'no-build') });
    const app = await buildApp({ config, store });
    try {
      assert.ok(!(await files()).includes(leftover));
    } finally {
      await app.close();
    }
  });

  it('runs again on its interval until stopped', async () => {
    const cleanup = await startVoiceCleanup({ store, voiceDir, now: () => now, log: Fastify().log, intervalMs: 10 });
    await stray(`${randomUUID()}.webm`, ago(2 * VOICE_ORPHAN_AGE_MS));
    for (let i = 0; i < 50 && (await files()).length > 0; i++) await tick(10);
    assert.deepEqual(await files(), []);

    cleanup.stop();
    const later = await stray(`${randomUUID()}.webm`, ago(2 * VOICE_ORPHAN_AGE_MS));
    await tick(50);
    assert.deepEqual(await files(), [later]);
  });
});
