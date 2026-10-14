import type { FastifyReply } from 'fastify';
import { HttpError } from './errors.ts';

interface Window {
  count: number;
  resetAt: number;
}

/** Fixed-window counter per key. Small and in-memory: one household, one process. */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private nextSweepAt = 0;

  constructor(limit: number, windowMs: number, clock: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  /** Records a hit for `key`. Returns 0 when allowed, else the seconds until the window resets. */
  hit(key: string): number {
    const now = this.clock();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return window.count > this.limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.windowMs;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

export function enforceLimit(limiter: RateLimiter, key: string, reply: FastifyReply): void {
  const retryAfter = limiter.hit(key);
  if (retryAfter > 0) {
    reply.header('retry-after', String(retryAfter));
    throw new HttpError(429, 'rate_limited');
  }
}
