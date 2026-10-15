// Typed HTTP client for the home server (contract: shared/api.ts).
// The server address is settings.serverUrl ('' = the origin that served the app,
// which is the normal setup since the server also hosts the PWA). Authenticated
// routes send the device token from settings as a bearer token.

import type {
  AiCanDoRequest,
  AiCanDoResponse,
  AiCheckRequest,
  AiCheckResponse,
  AiRecapRequest,
  AiRecapResponse,
  AiReportRequest,
  AiRolePlayRequest,
  AiRolePlayResponse,
  AiTranslateRequest,
  AiTranslateResponse,
  ChatMessage,
  CreateQuizRequest,
  HealthResponse,
  HouseholdResponse,
  Member,
  Quiz,
  QuizResultRequest,
  QuizzesResponse,
  RegisterRequest,
  RegisterResponse,
  RenameMemberRequest,
  SendMessageRequest,
  SendMessageResponse,
  StatsUploadRequest,
  TogetherEventRequest,
  TogetherState,
  TtsQuery,
  UploadVoiceResponse,
} from '../../shared/api.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import type { LastPairing, OutboxRecord, Settings } from '../lib/types.ts';

/**
 * A failed request. `status` is the HTTP status, or 0 when there was no response.
 * `code` is the server's `error` field, or one of the client-side codes:
 * 'network' (unreachable), 'timeout', 'aborted' (the caller's signal), 'unpaired'
 * (no device token), 'bad_response' (unreadable body) and 'invalid_server_url'
 * (the server address can't be one; its message says so in plain words).
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
    if (this.code === 'invalid_server_url' || this.code === 'aborted') return false;
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export const DEFAULT_TIMEOUT_MS = 8_000;
/** AI replies and voice uploads routinely take longer than the default. */
const SLOW_TIMEOUT_MS = 45_000;
/** Server speech: the engine synthesizes one request at a time, so a sentence can queue briefly. */
const TTS_TIMEOUT_MS = 15_000;
/** Disconnecting waits this long at most for the server to sign the phone out. */
const SIGN_OUT_TIMEOUT_MS = 3_000;

export const INVALID_SERVER_URL_MESSAGE = "That doesn't look like a server address (for example 192.168.1.20:8787).";

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

/**
 * Whether a typed server address can be one: '' (same origin), or http(s) with a host name or
 * IP address and an optional port and path. Catches typos before they turn into a misleading
 * "couldn't reach the home server".
 */
export function isServerUrl(input: string): boolean {
  const url = normalizeServerUrl(input);
  if (!url) return true;
  // Host (a name, IPv4 or [IPv6]) and an optional port, then an optional path.
  if (!/^https?:\/\/([a-z0-9_.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?(\/[^?#]*)?$/i.test(url)) return false;
  try {
    const { hostname } = new URL(url);
    return /^([a-z0-9_-]+(\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/i.test(hostname);
  } catch {
    return false;
  }
}

function endpoint(serverUrl: string | undefined, path: string): string {
  if (!isServerUrl(serverUrl ?? '')) throw new ApiError(0, 'invalid_server_url', INVALID_SERVER_URL_MESSAGE);
  return `${normalizeServerUrl(serverUrl ?? '')}${path}`;
}

/**
 * Why this page can't work offline, record voice or keep its storage, in plain words; null when
 * it can. Browsers allow service workers, the microphone and persistent storage only on secure
 * pages: https://, or http://localhost. A home server opened as http://192.168.1.20:8787 gets
 * none of them, so the app would need the network on every load.
 */
export function secureContextProblem(): string | null {
  if (typeof window === 'undefined' || window.isSecureContext !== false) return null;
  return "This address isn't secure (it starts with http://), so your browser won't let Issho work offline, "
    + 'record voice or keep your progress safe from clean-ups. Open Issho from its https:// address. '
    + 'Whoever set up your home server can turn that on (see its setup notes).';
}

const reachableListeners = new Set<() => void>();

/** Calls `cb` whenever the home server answered a request. Returns an unsubscribe function. */
export function onServerReachable(cb: () => void): () => void {
  reachableListeners.add(cb);
  return () => { reachableListeners.delete(cb); };
}

/** Tells the onServerReachable() listeners; every successful request does. */
export function serverReached(): void {
  for (const cb of [...reachableListeners]) {
    try { cb(); } catch (e) { console.error('server reachable listener failed', e); }
  }
}

export function isPairedSettings(s: Pick<Settings, 'deviceToken'>): boolean {
  return Boolean(s.deviceToken);
}

export async function isPaired(): Promise<boolean> {
  return isPairedSettings(await getSettings());
}

const REMOVED_KEY = 'issho.sync.removed';

/** Device tokens unpair() signed out on purpose (see forgetRevokedPairing). */
const signingOut = new Set<string>();

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
  // unpair() is signing this token out: the server then closes its socket as unpaired (and
  // answers other requests with 401), which is expected, not "this phone was removed".
  if (!token || signingOut.has(token) || (await getSettings()).deviceToken !== token) return;
  try {
    localStorage.setItem(REMOVED_KEY, '1');
  } catch {
    // Only the "this phone was disconnected" note is lost.
  }
  await forgetPairing();
}

/**
 * Clears the pairing on this device. Keeps `lastPairing`, which the chat cache and the outbox
 * belong to, so pairing with the same household again keeps them.
 */
async function forgetPairing(): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const s = await getSettings();
    const lastPairing: LastPairing | undefined = s.lastPairing
      ?? (s.memberId ? { memberId: s.memberId, serverUrl: normalizeServerUrl(s.serverUrl ?? '') } : undefined);
    await updateSettings({ deviceToken: undefined, memberId: undefined, householdName: undefined, lastPairing });
  });
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  /** JSON-serialized unless it is FormData. */
  body?: unknown;
  /** Send the device token (default true). */
  auth?: boolean;
  timeoutMs?: number;
  /** Overrides settings.serverUrl (used while pairing). */
  serverUrl?: string;
  as?: 'json' | 'blob';
  /** Forget the pairing when the server says 'unauthorized' (default true). */
  forgetIfUnauthorized?: boolean;
  /** Cancels the request: it then fails with ApiError code 'aborted'. */
  signal?: AbortSignal;
}

const abortedError = () => new ApiError(0, 'aborted', 'The request was cancelled.');

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs = DEFAULT_TIMEOUT_MS, as = 'json', forgetIfUnauthorized = true, signal } = opts;
  if (signal?.aborted) throw abortedError();
  const settings = await getSettings();
  const url = endpoint(opts.serverUrl ?? settings.serverUrl, path);
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
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // Cancelled while the settings were read: an aborted signal never fires 'abort' again.
  if (signal?.aborted) controller.abort();
  const cleanUp = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method, headers, body: payload, signal: controller.signal, cache: 'no-store',
    });
  } catch (e) {
    cleanUp();
    if (timedOut) throw new ApiError(0, 'timeout', 'The home server took too long to answer.');
    if (signal?.aborted) throw abortedError();
    throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Could not reach the home server.');
  }

  try {
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const err = (await res.json()) as { error?: unknown };
        if (typeof err?.error === 'string') code = err.error;
      } catch { /* non-JSON error body */ }
      if (auth && forgetIfUnauthorized && code === 'unauthorized') {
        await forgetRevokedPairing(settings.deviceToken!).catch((e: unknown) => console.error('could not forget the pairing', e));
      }
      throw new ApiError(res.status, code);
    }
    serverReached();
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
    if (signal?.aborted) throw abortedError();
    throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
  } finally {
    cleanUp();
  }
}

// ---- Routes ----------------------------------------------------------------

/** GET /api/health. Pass `serverUrl` to test an address before saving it. */
export function health(serverUrl?: string): Promise<HealthResponse> {
  return request('/api/health', { auth: false, serverUrl });
}

/** What aiStatus() found out about the home server's AI helper. */
export type AiStatus = 'on' | 'off' | 'unreachable';

/**
 * Whether the home server's AI helper can answer now (GET /api/health; never rejects):
 * - 'on': ask it;
 * - 'off': the server has no API key (or this phone isn't paired), so an AI request could only fail
 *   with 503 'ai_disabled': don't send one, and don't queue it for later either;
 * - 'unreachable': the server can't be reached right now; a check can wait for it.
 */
export async function aiStatus(): Promise<AiStatus> {
  try {
    if (!isPairedSettings(await getSettings())) return 'off';
    return (await health()).aiEnabled === true ? 'on' : 'off';
  } catch (e) {
    return e instanceof ApiError && e.code === 'invalid_server_url' ? 'off' : 'unreachable';
  }
}

/** POST /api/register. Low level: prefer pair(), which also stores the result. */
export function register(req: RegisterRequest, serverUrl?: string): Promise<RegisterResponse> {
  return request('/api/register', { method: 'POST', body: req, auth: false, serverUrl });
}

/** Outbox rows written for another household: they wait until the phone pairs with it again. */
export const OTHER_HOUSEHOLD = 'other_household';

const sameName = (a: string, b: string) => a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();

/** Whether a new pairing is with the household `before` was (or last was) paired with. */
function sameHousehold(before: Settings, serverUrl: string, res: RegisterResponse): boolean {
  const last = before.lastPairing;
  if (res.householdId && last?.householdId) return res.householdId === last.householdId;
  // Without household ids (an older server or pairing): the same member at the same address.
  const memberId = before.memberId ?? last?.memberId;
  const lastUrl = before.memberId ? normalizeServerUrl(before.serverUrl ?? '') : last?.serverUrl;
  return memberId === res.memberId && lastUrl === serverUrl;
}

/**
 * Joins the household and saves the server address, device token and name in settings.
 * Pairing again as this phone's own name (after Disconnect, or after being signed out)
 * signs in as the member it was, even if the name changed meanwhile.
 *
 * Unsent messages are never lost: rows written for this household (or before any pairing)
 * are delivered now; rows written for another household are marked OTHER_HOUSEHOLD and
 * wait, visible, until the phone pairs with that household again or the user resends them.
 * The chat cache is dropped only when the household changed: it mirrors one server's
 * history, whose message ids are the sync cursor.
 */
export async function pair(opts: { serverUrl: string; householdCode: string; name: string }): Promise<RegisterResponse> {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
  const name = opts.name.trim();
  const before = await getSettings();
  const previous = before.memberId ?? before.lastPairing?.memberId;
  const req: RegisterRequest = { householdCode: opts.householdCode.trim(), name };
  if (previous && sameName(name, before.name)) req.memberId = previous;
  const res = await register(req, serverUrl);

  const household = sameHousehold(before, serverUrl, res);
  await db.transaction('rw', db.messages, db.outbox, async () => {
    if (!household) await db.messages.clear();
    // An older server sends no household id: then every row goes out, as it always did.
    if (!res.householdId) return;
    await db.outbox.toCollection().modify((row: OutboxRecord) => {
      if (!row.householdId) {
        row.householdId = res.householdId;
      } else if (row.householdId === res.householdId) {
        if (row.failed === OTHER_HOUSEHOLD) delete row.failed;
      } else if (!row.failed) {
        row.failed = OTHER_HOUSEHOLD;
      }
    });
  });
  await updateSettings({
    serverUrl,
    deviceToken: res.deviceToken,
    memberId: res.memberId,
    householdName: res.householdName,
    name,
    lastPairing: { householdId: res.householdId, memberId: res.memberId, serverUrl },
  });
  try {
    localStorage.removeItem(REMOVED_KEY);
  } catch {
    // Storage blocked: there was no note to clear.
  }
  return res;
}

/**
 * Disconnects this phone: signs it out on the home server (best effort, briefly, so its
 * token stops working there), then forgets the pairing. The chat cache and unsent
 * messages stay for the next pairing with this household.
 */
export async function unpair(): Promise<void> {
  const token = (await getSettings()).deviceToken;
  if (token) {
    // Set before the request: the server closes this phone's socket as it signs it out, and
    // that close may arrive before the answer. The token never works again, so it stays here.
    signingOut.add(token);
    await signOut().catch(() => { /* Unreachable or already signed out: `admin revoke` covers it. */ });
  }
  await forgetPairing();
}

/** POST /api/signout. Low level: prefer unpair(). */
export async function signOut(): Promise<void> {
  await request<unknown>('/api/signout', { method: 'POST', timeoutMs: SIGN_OUT_TIMEOUT_MS, forgetIfUnauthorized: false });
}

/** PATCH /api/me: renames this phone's member. 409 'name_taken' when another member has the name. */
export function renameMember(name: string): Promise<Member> {
  return request('/api/me', { method: 'PATCH', body: { name: name.trim() } satisfies RenameMemberRequest });
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

/** POST /api/ai/check. 503 'ai_disabled' when the server has no API key: ask aiStatus() first. */
export function aiCheck(req: AiCheckRequest): Promise<AiCheckResponse> {
  return request('/api/ai/check', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/translate. 503 'ai_disabled' when the server has no API key. */
export function aiTranslate(req: AiTranslateRequest): Promise<AiTranslateResponse> {
  return request('/api/ai/translate', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/roleplay: the AI's next line as the task's third role. 503 'ai_disabled' without an API key. */
export function aiRolePlay(req: AiRolePlayRequest): Promise<AiRolePlayResponse> {
  return request('/api/ai/roleplay', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/recap: a private recap of one member's task lines. 503 'ai_disabled' without an API key. */
export function aiRecap(req: AiRecapRequest): Promise<AiRecapResponse> {
  return request('/api/ai/recap', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/cando: rubric check of a speak/write can-do. 503 'ai_disabled' without an API key. */
export function aiCanDo(req: AiCanDoRequest): Promise<AiCanDoResponse> {
  return request('/api/ai/cando', { method: 'POST', body: req, timeoutMs: SLOW_TIMEOUT_MS });
}

/** POST /api/ai/report → 204: "This tip seems wrong". */
export async function aiReport(req: AiReportRequest): Promise<void> {
  await request<unknown>('/api/ai/report', { method: 'POST', body: req });
}

/** GET /api/together: the couple's together routine (slots, goal, stages, sessions, tasks, check-ins). */
export function getTogether(): Promise<TogetherState> {
  return request('/api/together');
}

/**
 * POST /api/together/events (idempotent by clientId). Low level: prefer postTogetherEvent() in
 * together.ts, which queues the event so it is never lost offline.
 */
export function postTogetherEventRaw(req: TogetherEventRequest): Promise<TogetherState> {
  return request('/api/together/events', { method: 'POST', body: req });
}

/**
 * POST /api/tts → the home server's VOICEVOX reading of the text as a WAV Blob. The text goes in
 * the JSON body, never in the URL, so it never reaches a request log. 503 'tts_unavailable' when
 * the server has no engine (or it is down), 429 'rate_limited'.
 */
export function fetchTts(q: TtsQuery, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  return request('/api/tts', { method: 'POST', body: q, as: 'blob', timeoutMs: TTS_TIMEOUT_MS, signal: opts.signal });
}

/** ws(s)://…/api/ws?token=… for the paired server, or null when unpaired. */
export function socketUrl(s: Pick<Settings, 'serverUrl' | 'deviceToken'>, origin: string = location.origin): string | null {
  if (!s.deviceToken) return null;
  const base = normalizeServerUrl(s.serverUrl ?? '') || origin;
  return `${base.replace(/^http/i, 'ws')}/api/ws?token=${encodeURIComponent(s.deviceToken)}`;
}
