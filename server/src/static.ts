import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const IMMUTABLE = 'public, max-age=31536000, immutable';
// Everything without a content hash (index.html, sw.js, manifest, icons, data, the audio manifest)
// is revalidated with its ETag on every load, so a new deploy is picked up immediately.
const REVALIDATE = 'no-cache';
/** Voice clips are named by a hash of their content (public/audio/<aa>/<hash16>.m4a). */
const CLIP_RE = /\.m4a$/i;

/**
 * Serves the built PWA from `root`. Returns false (and serves nothing) when there's no build there.
 * Text files go out brotli- or gzip-compressed when the browser accepts it and the compressed copy
 * exists (see precompress.ts), with `Vary: Accept-Encoding`.
 */
export async function registerStatic(app: FastifyInstance, root: string): Promise<boolean> {
  if (!existsSync(path.join(root, 'index.html'))) {
    app.log.warn({ staticDir: root }, 'no built app found; serving the API only');
    return false;
  }

  const assetsDir = path.join(root, 'assets') + path.sep;
  const audioDir = path.join(root, 'audio') + path.sep;
  const immutable = (filePath: string) =>
    filePath.startsWith(assetsDir) || (filePath.startsWith(audioDir) && CLIP_RE.test(filePath));
  await app.register(fastifyStatic, {
    root,
    // `send` rejects `..` segments and paths outside `root`; dotfiles are never served.
    dotfiles: 'ignore',
    preCompressed: true,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(reply, filePath) {
      reply.header('cache-control', immutable(filePath) ? IMMUTABLE : REVALIDATE);
    },
  });
  return true;
}

/** Paths that only ever name files: a miss there is a 404, never the app's index.html. */
const FILE_ONLY = ['/api', '/audio', '/data'];

/**
 * Unknown /api routes and missing /audio and /data files get a JSON 404 (a service worker or
 * the data loader must not mistake index.html for a clip or a JSON file). Other GETs without a
 * file extension are client-side routes of the single-page app, so they get index.html.
 */
export function notFoundHandler(hasApp: boolean) {
  return async function notFound(request: FastifyRequest, reply: FastifyReply) {
    const pathname = request.url.split('?')[0];
    const fileOnly = FILE_ONLY.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (hasApp && !fileOnly && isPageRequest && !path.posix.extname(pathname)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  };
}
