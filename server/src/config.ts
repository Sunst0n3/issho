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
  aiProvider: 'off' | 'anthropic' | 'ollama';
  aiBaseUrl: string;
  aiModel: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  /**
   * Whose X-Forwarded-For to believe behind a reverse proxy (affects per-IP rate limits): the
   * proxy's addresses as a comma-separated list for Fastify, or true for every hop.
   */
  trustProxy: boolean | string;
  logLevel: string;
  /** VOICEVOX_URL: the speech engine POST /api/tts proxies to. null = server speech off. */
  voicevoxUrl: string | null;
  /** TTS_CACHE_MB: disk cap of synthesized speech in DATA_DIR/tts (10–5000, default 300). */
  ttsCacheMb: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Relative DATA_DIR / STATIC_DIR values are resolved from the server/ folder, not the cwd. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_TTS_CACHE_MB = 300;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const householdCode = env.HOUSEHOLD_CODE?.trim();
  if (!householdCode) {
    throw new ConfigError(
      'HOUSEHOLD_CODE is not set. Set it to the shared secret your phones will type to join the household.',
    );
  }

  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const aiProvider = env.AI_PROVIDER?.trim() || (anthropicApiKey ? 'anthropic' : 'off');
  if (!['off', 'anthropic', 'ollama'].includes(aiProvider)) {
    throw new ConfigError('AI_PROVIDER must be off, anthropic or ollama.');
  }
  if (aiProvider === 'anthropic' && !anthropicApiKey) {
    throw new ConfigError('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic.');
  }
  const aiBaseUrl = env.AI_BASE_URL?.trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  if (aiProvider === 'ollama') {
    let url: URL;
    try { url = new URL(aiBaseUrl); }
    catch { throw new ConfigError('AI_BASE_URL must be an http(s) address.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError('AI_BASE_URL must be an http(s) address without credentials, query or fragment.');
    }
  }

  return {
    aiProvider: aiProvider as Config['aiProvider'],
    aiBaseUrl,
    aiModel: env.AI_MODEL?.trim() || (aiProvider === 'ollama' ? 'qwen3.5:4b-q4_K_M' : env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL),
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || '0.0.0.0',
    ...loadAdminConfig(env),
    staticDir: resolveDir(env.STATIC_DIR, '../dist'),
    householdCode,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    voicevoxUrl: parseVoicevoxUrl(env.VOICEVOX_URL),
    ttsCacheMb: parseTtsCacheMb(env.TTS_CACHE_MB),
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
export function dataPaths(dataDir: string): { database: string; voice: string; tts: string } {
  return { database: path.join(dataDir, 'issho.db'), voice: path.join(dataDir, 'voice'), tts: path.join(dataDir, 'tts') };
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

/** VOICEVOX_URL: an http(s) address such as http://voicevox:50021 (trailing slashes dropped); unset or empty = off. */
function parseVoicevoxUrl(value: string | undefined): string | null {
  const text = value?.trim().replace(/\/+$/, '') ?? '';
  if (!text) return null;
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username) {
    throw new ConfigError(`VOICEVOX_URL must be the engine's http address, like http://voicevox:50021 (got "${value}").`);
  }
  return text;
}

function parseTtsCacheMb(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TTS_CACHE_MB;
  const mb = Number(value);
  if (!Number.isInteger(mb) || mb < 10 || mb > 5000) {
    throw new ConfigError(`TTS_CACHE_MB must be a whole number of megabytes between 10 and 5000 (got "${value}").`);
  }
  return mb;
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
