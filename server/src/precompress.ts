// Brotli and gzip copies of the built app's text files (file.js → file.js.br, file.js.gz), which
// the static server sends to browsers that accept them (see static.ts). The study data alone is
// about 7 MB, and the first visit downloads all of it for offline use; compressed it is under 2 MB.
//
// The Docker image makes them at build time (its app folder is read-only at run time):
//   node server/src/precompress.ts dist
// The server also makes any that are missing or out of date when it starts, after first removing
// copies an older build left behind (removeStaleCopies), so it never serves those meanwhile.
//
// Only node: modules here: the image's web build stage has no server dependencies installed.

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/** Text formats worth compressing; images and audio already are. */
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|webmanifest|svg|txt|xml|map)$/i;
/** Below this, the headers cost more than compression saves. */
const MIN_BYTES = 1024;

const ENCODINGS = [
  {
    ext: '.br',
    create: (size: number) =>
      zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
        },
      }),
  },
  { ext: '.gz', create: () => zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION }) },
] as const;

export interface PrecompressResult {
  /** Compressed copies written. */
  written: number;
  /** Compressed copies that were already up to date. */
  upToDate: number;
}

/**
 * Writes `<file>.br` and `<file>.gz` next to every compressible file under `root`, skipping copies
 * newer than their file. One file at a time, so a server starting up keeps its I/O threads free.
 * A copy is written under a temporary name and renamed, so it is never served half-written; one
 * that wouldn't be smaller isn't kept. Stops early (without error) when `signal` aborts.
 */
export async function precompressStatic(root: string, signal?: AbortSignal): Promise<PrecompressResult> {
  const result: PrecompressResult = { written: 0, upToDate: 0 };
  for (const file of await compressibleFiles(root)) {
    const source = await stat(file);
    if (source.size < MIN_BYTES) continue;
    for (const encoding of ENCODINGS) {
      if (signal?.aborted) return result;
      const target = file + encoding.ext;
      const existing = await stat(target).catch(() => null);
      if (existing && existing.mtimeMs >= source.mtimeMs) {
        result.upToDate++;
        continue;
      }
      const temp = `${target}.${process.pid}.tmp`;
      try {
        await pipeline(createReadStream(file), encoding.create(source.size), createWriteStream(temp), { signal });
        if ((await stat(temp)).size < source.size) {
          await rename(temp, target);
          result.written++;
        } else {
          await unlink(temp);
        }
      } catch (error) {
        await unlink(temp).catch(() => {});
        if (signal?.aborted) return result;
        throw error;
      }
    }
  }
  return result;
}

/**
 * Removes compressed copies that no longer match their file: older than it (a new build copied
 * over an old one without emptying the folder first) or left without it (a hashed file the new
 * build no longer has). Only stats and deletes, so it is quick enough to run before the server
 * answers: until precompressStatic() writes fresh copies, those files go out uncompressed rather
 * than as the old build's index.html pointing at assets that are gone. Returns how many it removed.
 */
export async function removeStaleCopies(root: string): Promise<number> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    const encoding = ENCODINGS.find((e) => entry.name.endsWith(e.ext));
    if (!entry.isFile() || !encoding) continue;
    const copy = path.join(entry.parentPath, entry.name);
    const file = copy.slice(0, -encoding.ext.length);
    if (!COMPRESSIBLE.test(file) || path.relative(root, copy).split(path.sep).some((part) => part.startsWith('.'))) continue;
    const [source, compressed] = await Promise.all([stat(file).catch(() => null), stat(copy)]);
    if (source && compressed.mtimeMs >= source.mtimeMs) continue;
    await unlink(copy);
    removed++;
  }
  return removed;
}

/** Compressible files under `root`, leaving out dotfiles and dot-folders (never served). */
async function compressibleFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && COMPRESSIBLE.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(root, file).split(path.sep).some((part) => part.startsWith('.')))
    .sort();
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node server/src/precompress.ts <built app folder>');
    process.exit(2);
  }
  const { written, upToDate } = await precompressStatic(path.resolve(root));
  console.log(`Precompressed ${root}: ${written} files written, ${upToDate} already up to date.`);
}
