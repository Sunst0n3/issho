import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const IMMUTABLE = 'public, max-age=31536000, immutable';
// Everything without a content hash (index.html, sw.js, manifest, icons, data) is revalidated
// with its ETag on every load, so a new deploy is picked up immediately.
const REVALIDATE = 'no-cache';

/** Serves the built PWA from `root`. Returns false (and serves nothing) when there's no build there. */
export async function registerStatic(app: FastifyInstance, root: string): Promise<boolean> {
  if (!existsSync(path.join(root, 'index.html'))) {
    app.log.warn({ staticDir: root }, 'no built app found; serving the API only');
    return false;
  }

  const assetsDir = path.join(root, 'assets') + path.sep;
  await app.register(fastifyStatic, {
    root,
    // `send` rejects `..` segments and paths outside `root`; dotfiles are never served.
    dotfiles: 'ignore',
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(reply, filePath) {
      reply.header('cache-control', filePath.startsWith(assetsDir) ? IMMUTABLE : REVALIDATE);
    },
  });
  return true;
}

/**
 * Unknown /api routes get a JSON 404. Other GETs without a file extension are client-side
 * routes of the single-page app, so they get index.html.
 */
export function notFoundHandler(hasApp: boolean) {
  return async function notFound(request: FastifyRequest, reply: FastifyReply) {
    const pathname = request.url.split('?')[0];
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (hasApp && !isApi && isPageRequest && !path.posix.extname(pathname)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  };
}
