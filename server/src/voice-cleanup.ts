import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Store } from './db.ts';

const HOUR = 60 * 60 * 1000;
/**
 * Phones upload a recording first and send its message afterwards, possibly much later from their
 * offline outbox, so a recording only counts as abandoned once it is this old.
 */
export const VOICE_ORPHAN_AGE_MS = 24 * HOUR;
export const VOICE_CLEANUP_INTERVAL_MS = 6 * HOUR;

/** Only files the voice route writes (`<uuid>.<ext>`) are ever deleted. */
const VOICE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/;

/**
 * Deletes recordings older than VOICE_ORPHAN_AGE_MS that no message uses, and files in `voiceDir`
 * that have no database row (an upload interrupted between writing the file and recording it).
 * Returns how many files were deleted.
 */
export async function cleanupOrphanedVoice(store: Store, voiceDir: string, now: Date): Promise<number> {
  const cutoff = now.getTime() - VOICE_ORPHAN_AGE_MS;
  // Read before deleting rows, so the files of rows deleted below don't also look like strays.
  const known = store.voiceFileNames();
  const doomed = new Set(store.deleteOrphanedVoice(new Date(cutoff).toISOString()));

  for (const name of await readdir(voiceDir)) {
    if (known.has(name) || doomed.has(name) || !VOICE_FILE.test(name)) continue;
    const info = await stat(path.join(voiceDir, name)).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) doomed.add(name);
  }

  let deleted = 0;
  for (const name of doomed) {
    try {
      await unlink(path.join(voiceDir, name));
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return deleted;
}

export interface VoiceCleanupOptions {
  store: Store;
  voiceDir: string;
  now: () => Date;
  log: FastifyBaseLogger;
  intervalMs?: number;
}

/** Cleans up now, then every VOICE_CLEANUP_INTERVAL_MS until the returned stop() is called. */
export async function startVoiceCleanup(options: VoiceCleanupOptions): Promise<{ stop: () => void }> {
  const { store, voiceDir, now, log } = options;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const deleted = await cleanupOrphanedVoice(store, voiceDir, now());
      if (deleted > 0) log.info({ deleted }, 'deleted unused voice recordings');
    } catch (error) {
      log.error({ err: error }, 'voice cleanup failed');
    } finally {
      running = false;
    }
  };

  await run();
  const timer = setInterval(() => void run(), options.intervalMs ?? VOICE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
