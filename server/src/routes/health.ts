import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../../shared/api.ts';
import type { AppContext } from '../context.ts';

export function healthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Polled by the container healthcheck every 30 s, so keep it out of the info log.
  app.get('/api/health', { logLevel: 'warn' }, async (): Promise<HealthResponse> => ({
    ok: true,
    version: ctx.version,
    aiEnabled: ctx.ai !== null,
  }));
}
