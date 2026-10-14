// Typed HTTP client for the home server (contract: shared/api.ts).
// The server address is settings.serverUrl ('' = the origin that served the app,
// which is the normal setup since the server also hosts the PWA). Authenticated
// routes send the device token from settings as a bearer token.

import type {
  AiCheckRequest,
  AiCheckResponse,
  AiTranslateRequest,
  AiTranslateResponse,
  ChatMessage,
  CreateQuizRequest,
  HealthResponse,
  HouseholdResponse,
  Quiz,
  QuizResultRequest,
  QuizzesResponse,
  RegisterRequest,
  RegisterResponse,
  SendMessageRequest,
  SendMessageResponse,
  StatsUploadRequest,
  UploadVoiceResponse,
} from '../../shared/api.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import type { Settings } from '../lib/types.ts';

/**
 * A failed request. `status` is the HTTP status, or 0 when there was no response.
 * `code` is the server's `error` field, or one of the client-side codes:
 * 'network' (unreachable), 'timeout', 'unpaired' (no device token) and
 * 'bad_response' (unreadable body).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? `${code}${status ? ` (${status})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** Worth retrying later: no response, a timeout, rate limiting or a server-side failure. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export const DEFAULT_TIMEOUT_MS = 8_000;
/** AI replies and voice uploads routinely take longer than the default. */
const SLOW_TIMEOUT_MS = 45_000;

/**
 * Cleans up a server address typed by a person: trims, drops trailing slashes and
 * a trailing /api, and adds a scheme when missing (http for IPs, localhost and
 * explicit ports, which is how a home server on the LAN is usually reached;
 * https otherwise). '' stays '' (same origin).
 */
export function normalizeServerUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url.replace(/^https?/i, (scheme) => scheme.toLowerCase());
  const host = url.split('/')[0];
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) || /:\d+$/.test(host);
  return `${local ? 'http' : 'https'}://${url}`;
}

function endpoint(serverUrl: string | undefined, path: string): string {
  return `${normalizeServerUrl(serverUrl ?? '')}${path}`;
}

export function isPairedSettings(s: Pick<Settings, 'deviceToken'>): boolean {
  return Boolean(s.deviceToken);
}

export async function isPaired(): Promise<boolean> {
  return isPairedSettings(await getSettings());
}

const REMOVED_KEY = 'issho.sync.removed';

/** The home server stopped accepting this phone (removed from the household) and it hasn't paired again since. */
export function wasRemoved(): boolean {
  try {
    return localStorage.getItem(REMOVED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Forgets a pairing the home server no longer accepts (a 401 'unauthorized', or the
 * socket closed as unpaired: the phone was removed with the admin CLI, or the server's
 * data was reset), so the app offers to pair again instead of retrying forever. Does
 * nothing when `token` is no longer this phone's, i.e. it has paired again since.
 */
export async function forgetRevokedPairing(token: string): Promise<void> {
  if (!token || (await getSettings()).deviceToken !== token) return;
  try {
    localStorage.setItem(REMOVED_KEY, '1');
  } catch {
    // Only the "this phone was disconnected" note is lost.
  }
  await unpair();
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  /** JSON-serialized unless it is FormData. */
  body?: unknown;
  /** Send the device token (default true). */
  auth?: boolean;
  timeoutMs?: number;
  /** Overrides settings.serverUrl (used while pairing). */
  serverUrl?: string;
  as?: 'json' | 'blob';
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs = DEFAULT_TIMEOUT_MS, as = 'json' } = opts;
  const settings = await getSettings();
  const headers: Record<string, string> = { Accept: as === 'json' ? 'application/json' : '*/*' };
  if (auth) {
    if (!settings.deviceToken) throw new ApiError(0, 'unpaired', 'This device is not paired with the home server.');
    headers.Authorization = `Bearer ${settings.deviceToken}`;
  }
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(endpoint(opts.serverUrl ?? settings.serverUrl, path), {
      method, headers, body: payload, signal: controller.signal, cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (timedOut) throw new ApiError(0, 'timeout', 'The home server took too long to answer.');
    throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Could not reach the home server.');
  }

  try {
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const err = (await res.json()) as { error?: unknown };
        if (typeof err?.error === 'string') code = err.error;
      } catch { /* non-JSON error body */ }
      if (auth && code === 'unauthorized') {
        await forgetRevokedPairing(settings.deviceToken!).catch((e: unknown) => console.error('could not forget the pairing', e));
      }
      throw new ApiError(res.status, code);
    }
    if (as === 'blob') return (await res.blob()) as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, 'bad_response', 'The home server sent a response that could not be read.');
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) throw new ApiError(0, 'timeout', 'The home server took too long to answer.');
    throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

// ---- Routes ----------------------------------------------------------------

/** GET /api/health. Pass `serverUrl` to test an address before saving it. */
export function health(serverUrl?: string): Promise<HealthResponse> {
  return request('/api/health', { auth: false, serverUrl });
}

/** POST /api/register. Low level: prefer pair(), which also stores the result. */
export function register(req: RegisterRequest, serverUrl?: string): Promise<RegisterResponse> {
  return request('/api/register', { method: 'POST', body: req, auth: false, serverUrl });
}

/**
 * Joins the household and saves the server address and device token in settings.
 * Switching to a different server or member clears the local chat cache and
 * outbox, which belong to the old household.
 */
export async function pair(opts: { serverUrl: string; householdCode: string; name: string }): Promise<RegisterResponse> {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
  const res = await register({ householdCode: opts.householdCode.trim(), name: opts.name.trim() }, serverUrl);
  const before = await getSettings();
  if (before.memberId !== res.memberId || normalizeServerUrl(before.serverUrl ?? '') !== serverUrl) {
    await db.transaction('rw', db.messages, db.outbox, async () => {
      await db.messages.clear();
      await db.outbox.clear();
    });
  }
  await updateSettings({
    serverUrl,
    deviceToken: res.deviceToken,
    memberId: res.memberId,
    householdName: res.householdName,
    ...(before.name ? {} : { name: opts.name.trim() }),
  });
  try {
    localStorage.removeItem(REMOVED_KEY);
  } catch {
    // Storage blocked: there was no note to clear.
  }
  return res;
}

/** Forgets the pairing on this device (the chat cache stays until the next pair()). */
export async function unpair(): Promise<void> {
  await updateSettings({ deviceToken: undefined, memberId: undefined, householdName: undefined });
}

/** GET /api/household */
export function getHousehold(): Promise<HouseholdResponse> {
  return request('/api/household');
}

/** POST /api/stats */
export async function uploadStats(req: StatsUploadRequest): Promise<void> {
  await request<unknown>('/api/stats', { method: 'POST', body: req });
}

/** GET /api/messages?after=&limit= → oldest first. */
export function getMessages(after = 0, limit = 100): Promise<ChatMessage[]> {
  return request(`/api/messages?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
}

/** POST /api/messages (idempotent by clientId). */
export function sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
  return request('/api/messages', { method: 'POST', body: req });
}

const AUDIO_EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

/** POST /api/voice (multipart field "audio"). */
export function uploadVoice(audio: Blob): Promise<UploadVoiceResponse> {
  // The server matches bare content types, so drop codec parameters like ";codecs=opus".
  const type = audio.type.split(';')[0].trim().toLowerCase() || 'audio/mp4';
  const form = new FormData();
  form.append('audio', audio.slice(0, audio.size, type), `voice.${AUDIO_EXT[type] ?? 'bin'}`);
  return request('/api/voice', { method: 'POST', body: form, timeoutMs: SLOW_TIMEOUT_MS });
}

/** GET /api/voice/:audioId → the audio bytes (needs the bearer token, so not usable as a plain src URL). */
export function fetchVoice(audioId: string): Promise<Blob> {
  return request(`/api/voice/${encodeURIComponent(audioId)}`, { as: 'blob', timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/quizzes */
export function createQuiz(req: CreateQuizRequest): Promise<Quiz> {
  return request('/api/quizzes', { method: 'POST', body: req });
}

/** GET /api/quizzes */
export function getQuizzes(): Promise<QuizzesResponse> {
  return request('/api/quizzes');
}

/** POST /api/quizzes/:id/result */
export function submitQuizResult(id: string, req: QuizResultRequest): Promise<Quiz> {
  return request(`/api/quizzes/${encodeURIComponent(id)}/result`, { method: 'POST', body: req });
}

/** POST /api/ai/check. 503 'ai_disabled' when the server has no API key. */
export function aiCheck(req: AiCheckRequest): Promise<AiCheckResponse> {
  return request('/api/ai/check', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/translate. 503 'ai_disabled' when the server has no API key. */
export function aiTranslate(req: AiTranslateRequest): Promise<AiTranslateResponse> {
  return request('/api/ai/translate', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** ws(s)://…/api/ws?token=… for the paired server, or null when unpaired. */
export function socketUrl(s: Pick<Settings, 'serverUrl' | 'deviceToken'>, origin: string = location.origin): string | null {
  if (!s.deviceToken) return null;
  const base = normalizeServerUrl(s.serverUrl ?? '') || origin;
  return `${base.replace(/^http/i, 'ws')}/api/ws?token=${encodeURIComponent(s.deviceToken)}`;
}
