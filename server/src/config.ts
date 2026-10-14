import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  /** SQLite database and voice files live here. */
  dataDir: string;
  /** The built PWA (vite `dist/`). */
  staticDir: string;
  householdCode: string;
  /** HOUSEHOLD_NAME. A name set with the admin CLI (stored in the database) takes precedence. */
  householdName: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  /**
   * Whose X-Forwarded-For to believe behind a reverse proxy (affects per-IP rate limits): the
   * proxy's addresses as a comma-separated list for Fastify, or true for every hop.
   */
  trustProxy: boolean | string;
  logLevel: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Relative DATA_DIR / STATIC_DIR values are resolved from the server/ folder, not the cwd. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const householdCode = env.HOUSEHOLD_CODE?.trim();
  if (!householdCode) {
    throw new ConfigError(
      'HOUSEHOLD_CODE is not set. Set it to the shared secret your phones will type to join the household.',
    );
  }

  return {
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || '0.0.0.0',
    ...loadAdminConfig(env),
    staticDir: resolveDir(env.STATIC_DIR, '../dist'),
    householdCode,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  };
}

/** What the admin CLI shares with the server. Unlike loadConfig() it needs no HOUSEHOLD_CODE. */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, 'dataDir' | 'householdName'> {
  return {
    dataDir: resolveDir(env.DATA_DIR, './data'),
    householdName: env.HOUSEHOLD_NAME?.trim() || 'Our home',
  };
}

/** Where things live inside DATA_DIR. */
export function dataPaths(dataDir: string): { database: string; voice: string } {
  return { database: path.join(dataDir, 'issho.db'), voice: path.join(dataDir, 'voice') };
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a whole number between 1 and 65535 (got "${value}").`);
  }
  return port;
}

/**
 * TRUST_PROXY names the reverse proxy: IPs, CIDR ranges or "loopback", comma-separated. Then
 * request.ip is the address that proxy saw. "true" believes the whole X-Forwarded-For chain, whose
 * left end the client writes itself, so a client could pick a new IP per request and dodge the
 * register rate limit.
 */
function parseTrustProxy(value: string | undefined): boolean | string {
  const text = value?.trim() ?? '';
  const lower = text.toLowerCase();
  if (['', '0', 'false', 'no'].includes(lower)) return false;
  if (['1', 'true', 'yes'].includes(lower)) return true;

  const entries = text.split(',').map((entry) => entry.trim());
  const bad = entries.find((entry) => !isProxyAddress(entry));
  if (bad !== undefined) {
    throw new ConfigError(
      `TRUST_PROXY must be the proxy's IPs, CIDR ranges or "loopback", comma-separated (got "${bad}").`,
    );
  }
  return entries.join(',');
}

const NAMED_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(entry: string): boolean {
  if (NAMED_PROXY_RANGES.has(entry)) return true;
  const [address, mask, ...rest] = entry.split('/');
  return rest.length === 0 && isIP(address) !== 0 && (mask === undefined || /^\d{1,3}$/.test(mask) || isIP(mask) !== 0);
}

function resolveDir(value: string | undefined, fallback: string): string {
  return path.resolve(SERVER_DIR, value?.trim() || fallback);
}
