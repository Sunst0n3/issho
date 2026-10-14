import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Member } from '../../shared/api.ts';
import type { AppContext } from './context.ts';
import { HttpError } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated member; set by authHook() on protected routes. */
    member: Member | null;
  }
}

const TOKEN_BYTES = 32;
/** 32 random bytes in base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LAST_SEEN_RESOLUTION_MS = 60_000;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Only the SHA-256 of a device token is stored, so a leaked database can't be used to sign in. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

export function authenticate(ctx: AppContext, token: string | null): Member | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const member = ctx.store.memberForTokenHash(hashToken(token));
  if (!member) return null;
  ctx.store.touchMember(member.id, ctx.now(), LAST_SEEN_RESOLUTION_MS);
  return member;
}

/** onRequest hook that rejects the request with 401 unless `extract` yields a valid device token. */
export function authHook(ctx: AppContext, extract: (request: FastifyRequest) => string | null) {
  return async function requireMember(request: FastifyRequest): Promise<void> {
    const member = authenticate(ctx, extract(request));
    if (!member) throw new HttpError(401, 'unauthorized');
    request.member = member;
  };
}

export function currentMember(request: FastifyRequest): Member {
  if (!request.member) throw new HttpError(401, 'unauthorized');
  return request.member;
}
