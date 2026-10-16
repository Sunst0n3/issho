import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BackupSnapshot } from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';

const KEEP = 14;
const ID = /^\d{13}-[0-9a-f-]{36}$/;
const SnapshotSchema = z.object({
  format: z.literal('issho-backup'), version: z.literal(2), exportedAt: z.iso.datetime(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
interface StoredSnapshot extends BackupSnapshot { backup: z.infer<typeof SnapshotSchema> }

/** Snapshots are private files in the existing persistent /data volume, never in the web root. */
export function backupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const directory = (member: string) => path.join(ctx.config.dataDir, 'backups', createHash('sha256').update(member).digest('hex'));
  const names = async (dir: string): Promise<string[]> => {
    try { return (await readdir(dir)).filter((s) => s.endsWith('.json') && ID.test(s.slice(0, -5))).sort().reverse(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  };
  const read = async (dir: string, id: string): Promise<StoredSnapshot> => {
    if (!ID.test(id)) throw new HttpError(404, 'not_found');
    try { return JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')) as StoredSnapshot; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not_found'); throw e; }
  };

  app.post('/api/backups', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply): Promise<BackupSnapshot> => {
    const member = currentMember(request);
    const backup = parseWith(SnapshotSchema, request.body);
    const settings = backup.tables.settings;
    if (!settings || settings.length !== 1 || settings[0].memberId !== member.id
      || settings[0].deviceToken !== undefined
      || !['items', 'cards', 'reviewLogs', 'days'].every((key) => Array.isArray(backup.tables[key]))) {
      throw new HttpError(400, 'invalid_request');
    }
    const dir = directory(member.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const createdAt = ctx.now().toISOString();
    const id = `${Date.parse(createdAt)}-${randomUUID()}`;
    const metadata = { id, createdAt, bytes: Buffer.byteLength(JSON.stringify(backup)) };
    const target = path.join(dir, `${id}.json`);
    const temporary = `${target}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...metadata, backup }), { mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    for (const stale of (await names(dir)).slice(KEEP)) await rm(path.join(dir, stale), { force: true });
    reply.code(201);
    return metadata;
  });

  app.get('/api/backups', async (request): Promise<BackupSnapshot[]> => {
    const dir = directory(currentMember(request).id);
    return Promise.all((await names(dir)).map(async (name) => {
      const id = name.slice(0, -5);
      return { id, createdAt: new Date(Number(id.slice(0, 13))).toISOString(), bytes: (await stat(path.join(dir, name))).size };
    }));
  });

  app.get<{ Params: { id: string } }>('/api/backups/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return (await read(directory(currentMember(request).id), request.params.id)).backup;
  });
}
