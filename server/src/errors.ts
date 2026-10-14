import type { z } from 'zod';

/** An expected failure that maps to a JSON `{ error }` response. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(statusCode: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

/** Validates untrusted input; failures become 400s that name the bad fields but never echo values. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_request', detail);
  }
  return result.data;
}

/** Stable error codes for Fastify's own 4xx errors (bad JSON, body too large, …). */
export function clientErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 406:
    case 415:
      return 'unsupported_media_type';
    case 413:
      return 'too_large';
    case 429:
      return 'rate_limited';
    default:
      return 'bad_request';
  }
}
