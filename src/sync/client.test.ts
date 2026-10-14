import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/api.ts';
import { db, getSettings, updateSettings } from '../lib/db.ts';
import {
  ApiError,
  aiCheck,
  forgetRevokedPairing,
  getHousehold,
  getMessages,
  health,
  isPaired,
  isServerUrl,
  normalizeServerUrl,
  onServerReachable,
  pair,
  renameMember,
  secureContextProblem,
  sendMessage,
  socketUrl,
  unpair,
  uploadVoice,
  wasRemoved,
} from './client.ts';

/** Fakes timeouts only: fake-indexeddb runs on setImmediate, which must stay real or Dexie stalls. */
const useTimerFakes = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn<typeof fetch>();

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  await updateSettings({ serverUrl: 'http://192.168.1.20:8787', deviceToken: 'tok-123', memberId: 'm1' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requests', () => {
  it('sends the bearer token and JSON body to the configured server', async () => {
    const msg: ChatMessage = { id: 7, clientId: 'c1', memberId: 'm1', createdAt: '2026-10-14T10:00:00Z', kind: 'text', text: 'おはよう' };
    fetchMock.mockResolvedValueOnce(json(msg));

    await expect(sendMessage({ clientId: 'c1', kind: 'text', text: 'おはよう' })).resolves.toEqual(msg);

    const { url, init, headers } = lastCall();
    expect(url).toBe('http://192.168.1.20:8787/api/messages');
    expect(init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ clientId: 'c1', kind: 'text', text: 'おはよう' });
  });

  it('uses the same origin when serverUrl is empty', async () => {
    await updateSettings({ serverUrl: '' });
    fetchMock.mockResolvedValueOnce(json({ householdName: 'Home', me: 'm1', members: [], sharedStreak: 0 }));
    await getHousehold();
    expect(lastCall().url).toBe('/api/household');
  });

  it('builds the messages query string', async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    await getMessages(42, 50);
    expect(lastCall().url).toBe('http://192.168.1.20:8787/api/messages?after=42&limit=50');
  });

  it('refuses authenticated calls when unpaired, without touching the network', async () => {
    await updateSettings({ deviceToken: undefined });
    await expect(getHousehold()).rejects.toMatchObject({ status: 0, code: 'unpaired' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await isPaired()).toBe(false);
  });

  it('calls public routes without a token, at an explicit address', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, version: '1', aiEnabled: false }));
    await health('home.local:8787');
    const { url, headers } = lastCall();
    expect(url).toBe('http://home.local:8787/api/health');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('errors', () => {
  it('maps a JSON error body to ApiError { status, code }', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'ai_disabled' }, 503));
    const err = await aiCheck({ text: 'こんにちは' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'ai_disabled', transient: true });
  });

  it('marks client errors as permanent', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_body' }, 400));
    await expect(sendMessage({ clientId: 'c', kind: 'text', text: '' })).rejects.toMatchObject({
      status: 400, code: 'invalid_body', transient: false,
    });
  });

  it('falls back to http_<status> for a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(getHousehold()).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('reports an unreachable server as a transient network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getHousehold()).rejects.toMatchObject({ status: 0, code: 'network', transient: true });
  });

  it('reports an unreadable success body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(getHousehold()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('times out after 8 seconds', async () => {
    useTimerFakes();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = getHousehold().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 0, code: 'timeout', transient: true });
  });

  it('gives AI requests longer than the default timeout', async () => {
    useTimerFakes();
    let aborted = false;
    fetchMock.mockImplementationOnce((_url, init) => new Promise((resolve) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => resolve(json({ ok: true, corrected: 'x', tips: [], correctedRuby: 'x' })), 20_000);
    }));
    const pending = aiCheck({ text: 'x' });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(aborted).toBe(false);
  });
});

describe('a phone the server no longer accepts', () => {
  it('forgets the pairing on 401 unauthorized, and pairing again clears the note', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, 401));
    await expect(getHousehold()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(await getSettings()).toMatchObject({ deviceToken: undefined, memberId: undefined, serverUrl: 'http://192.168.1.20:8787' });
    expect(wasRemoved()).toBe(true);

    fetchMock.mockResolvedValueOnce(json({ deviceToken: 'tok-2', memberId: 'm1', householdName: 'Home' }));
    await pair({ serverUrl: 'http://192.168.1.20:8787', householdCode: 'x', name: 'Carter' });
    expect(wasRemoved()).toBe(false);
  });

  it('keeps a pairing made since the rejected request was sent', async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const request = getHousehold().catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await updateSettings({ deviceToken: 'tok-new' });
    answer(json({ error: 'unauthorized' }, 401));
    expect(await request).toMatchObject({ code: 'unauthorized' });
    expect((await getSettings()).deviceToken).toBe('tok-new');
    expect(wasRemoved()).toBe(false);
  });

  it('keeps the pairing for other 401s, such as a proxy asking for a password', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Authorization required', { status: 401 }));
    await expect(getHousehold()).rejects.toMatchObject({ status: 401, code: 'http_401' });
    expect((await getSettings()).deviceToken).toBe('tok-123');
  });
});

describe('uploadVoice', () => {
  it('posts multipart field "audio" with a bare content type and a matching file name', async () => {
    const appended: Array<{ name: string; value: Blob; filename?: string }> = [];
    // jsdom's FormData can't be inspected after the fact in a portable way; record appends instead.
    class RecordingFormData {
      append(name: string, value: Blob, filename?: string) { appended.push({ name, value, filename }); }
    }
    vi.stubGlobal('FormData', RecordingFormData);
    fetchMock.mockResolvedValueOnce(json({ audioId: 'a1' }));

    const audio = new Blob(['abc'], { type: 'audio/webm;codecs=opus' });
    await expect(uploadVoice(audio)).resolves.toEqual({ audioId: 'a1' });

    const { url, init, headers } = lastCall();
    expect(url).toBe('http://192.168.1.20:8787/api/voice');
    expect(init.body).toBeInstanceOf(RecordingFormData);
    // The browser must set the multipart boundary itself.
    expect(headers['Content-Type']).toBeUndefined();
    expect(appended).toHaveLength(1);
    expect(appended[0].name).toBe('audio');
    expect(appended[0].filename).toBe('voice.webm');
    expect(appended[0].value.type).toBe('audio/webm');
    expect(appended[0].value.size).toBe(3);
  });
});

describe('pair', () => {
  it('registers, stores the pairing and clears chat from a previous household', async () => {
    await db.messages.put({ id: 1, clientId: 'old', memberId: 'm1', createdAt: '2026-01-01T00:00:00Z', kind: 'text', text: 'old' });
    fetchMock.mockResolvedValueOnce(json({ deviceToken: 'new-token', memberId: 'm9', householdName: 'Our home', householdId: 'h9' }));

    await pair({ serverUrl: 'https://issho.example.com/', householdCode: ' secret ', name: 'Carter' });

    const { url, init, headers } = lastCall();
    expect(url).toBe('https://issho.example.com/api/register');
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ householdCode: 'secret', name: 'Carter' });
    const s = await getSettings();
    expect(s).toMatchObject({
      serverUrl: 'https://issho.example.com', deviceToken: 'new-token', memberId: 'm9', householdName: 'Our home', name: 'Carter',
      lastPairing: { householdId: 'h9', memberId: 'm9', serverUrl: 'https://issho.example.com' },
    });
    expect(await db.messages.count()).toBe(0);
  });

  it('saves the name it registered with, even when the phone had another one', async () => {
    await updateSettings({ name: 'Carter' });
    fetchMock.mockResolvedValueOnce(json({ deviceToken: 't', memberId: 'm2', householdName: 'Home', householdId: 'h' }));
    await pair({ serverUrl: '', householdCode: 'x', name: ' Carter C ' });
    expect((await getSettings()).name).toBe('Carter C');
  });

  it("pairs again as the member this phone was, when it uses this phone's own name", async () => {
    await updateSettings({ name: 'Carter C' });
    fetchMock.mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(
      json({ deviceToken: 't2', memberId: 'm1', householdName: 'Home', householdId: 'h' }),
    );
    await unpair();
    await pair({ serverUrl: 'http://192.168.1.20:8787', householdCode: 'x', name: 'Carter C' });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ householdCode: 'x', name: 'Carter C', memberId: 'm1' });

    // Someone else using this phone (another name) is not signed in as its old member.
    await updateSettings({ deviceToken: undefined, memberId: undefined });
    fetchMock.mockResolvedValueOnce(json({ deviceToken: 't3', memberId: 'm7', householdName: 'Home', householdId: 'h' }));
    await pair({ serverUrl: 'http://192.168.1.20:8787', householdCode: 'x', name: 'Mika' });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ householdCode: 'x', name: 'Mika' });
  });

  it('refuses an address that cannot be a server, without calling anything', async () => {
    const err = await pair({ serverUrl: 'not a url!!', householdCode: 'x', name: 'C' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'invalid_server_url', transient: false });
    expect((err as ApiError).message).toMatch(/doesn't look like a server address \(for example 192\.168\.1\.20:8787\)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getSettings()).deviceToken).toBe('tok-123');
  });

  it('keeps the chat cache when re-pairing as the same member on the same server', async () => {
    await db.messages.put({ id: 1, clientId: 'keep', memberId: 'm1', createdAt: '2026-01-01T00:00:00Z', kind: 'text', text: 'hi' });
    fetchMock.mockResolvedValueOnce(json({ deviceToken: 'tok-2', memberId: 'm1', householdName: 'Home' }));
    await pair({ serverUrl: 'http://192.168.1.20:8787', householdCode: 'x', name: 'Carter' });
    expect(await db.messages.count()).toBe(1);
  });

  it('leaves settings untouched when registration fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'bad_code' }, 403));
    await expect(pair({ serverUrl: 'http://other:8787', householdCode: 'nope', name: 'C' })).rejects.toMatchObject({ code: 'bad_code' });
    expect((await getSettings()).deviceToken).toBe('tok-123');
  });
});

describe('unpair', () => {
  it('signs this phone out on the server, then forgets the pairing here', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await unpair();
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://192.168.1.20:8787/api/signout');
    expect(init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer tok-123');
    const s = await getSettings();
    expect(s).toMatchObject({ deviceToken: undefined, memberId: undefined });
    // What the chat cache and outbox belong to is remembered for the next pairing.
    expect(s.lastPairing).toEqual({ memberId: 'm1', serverUrl: 'http://192.168.1.20:8787' });
    // Disconnecting on purpose isn't "this phone was disconnected".
    expect(wasRemoved()).toBe(false);
  });

  it('still disconnects when the server is unreachable or already signed it out', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await unpair();
    expect((await getSettings()).deviceToken).toBeUndefined();

    await updateSettings({ deviceToken: 'tok-123', memberId: 'm1' });
    fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, 401));
    await unpair();
    expect((await getSettings()).deviceToken).toBeUndefined();
    expect(wasRemoved()).toBe(false);
  });

  it("doesn't say 'removed' when the server closes the socket as it signs the phone out", async () => {
    // The server closes this device's socket with WS_CLOSE_UNPAIRED before it answers, and
    // socket.ts then calls forgetRevokedPairing; other requests in flight may get a 401.
    fetchMock.mockImplementationOnce(async () => {
      await forgetRevokedPairing('tok-123');
      return json({ ok: true });
    });
    await unpair();
    expect((await getSettings()).deviceToken).toBeUndefined();
    expect(wasRemoved()).toBe(false);
    // A close that arrives after the answer changes nothing either.
    await forgetRevokedPairing('tok-123');
    expect(wasRemoved()).toBe(false);
  });

  it("doesn't wait long for a server that doesn't answer", async () => {
    useTimerFakes();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const done = unpair();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect((await getSettings()).deviceToken).toBeUndefined();
  });
});

describe('renameMember', () => {
  it('sends PATCH /api/me with the trimmed name', async () => {
    const member = { id: 'm1', name: 'Carter C', joinedAt: '2026-10-01T00:00:00Z', lastSeenAt: null };
    fetchMock.mockResolvedValueOnce(json(member));
    await expect(renameMember(' Carter C ')).resolves.toEqual(member);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://192.168.1.20:8787/api/me');
    expect(init.method).toBe('PATCH');
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Carter C' });
  });

  it('reports a taken name', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'name_taken' }, 409));
    await expect(renameMember('Mika')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
  });
});

describe('server reachability', () => {
  it('tells listeners when the server answered', async () => {
    const reached = vi.fn();
    const off = onServerReachable(reached);
    try {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await getHousehold().catch(() => {});
      expect(reached).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(json({ householdName: 'Home', me: 'm1', members: [], sharedStreak: 0 }));
      await getHousehold();
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

describe('secureContextProblem', () => {
  it('explains, in plain words, why an http:// page cannot work offline', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(secureContextProblem()).toMatch(/https:\/\//);
    expect(secureContextProblem()).toMatch(/offline/);
  });

  it('is null on https:// and localhost', () => {
    vi.stubGlobal('isSecureContext', true);
    expect(secureContextProblem()).toBeNull();
  });
});

describe('isServerUrl', () => {
  it.each(['', '192.168.1.20:8787', 'http://192.168.1.20:8787', 'homeserver:8787', 'issho.example.com', 'https://issho.tail1234.ts.net', '[fe80::1]:8787', 'https://example.com/issho'])(
    'accepts %j',
    (input) => expect(isServerUrl(input)).toBe(true),
  );
  it.each(['not a url!!', 'http://', 'ftp://example.com', 'https://exa mple.com', 'example.com:abc', 'https://user:pw@example.com', 'https://example.com/?q=1', '!!'])(
    'rejects %j',
    (input) => expect(isServerUrl(input)).toBe(false),
  );
});

describe('normalizeServerUrl', () => {
  it.each([
    ['', ''],
    ['  ', ''],
    ['http://192.168.1.20:8787/', 'http://192.168.1.20:8787'],
    ['192.168.1.20:8787', 'http://192.168.1.20:8787'],
    ['localhost:8787', 'http://localhost:8787'],
    ['homeserver:8787', 'http://homeserver:8787'],
    ['issho.example.com', 'https://issho.example.com'],
    ['https://issho.example.com/api/', 'https://issho.example.com'],
    ['HTTPS://Issho.example.com', 'https://Issho.example.com'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });
});

describe('socketUrl', () => {
  it('is null when unpaired', () => {
    expect(socketUrl({ serverUrl: 'http://x', deviceToken: undefined })).toBeNull();
  });

  it('switches http(s) to ws(s) and passes the token', () => {
    expect(socketUrl({ serverUrl: 'https://issho.example.com', deviceToken: 'a b' }))
      .toBe('wss://issho.example.com/api/ws?token=a%20b');
    expect(socketUrl({ serverUrl: '192.168.1.20:8787', deviceToken: 't' }))
      .toBe('ws://192.168.1.20:8787/api/ws?token=t');
  });

  it('uses the page origin for same-origin servers', () => {
    expect(socketUrl({ serverUrl: '', deviceToken: 't' }, 'https://home.example')).toBe('wss://home.example/api/ws?token=t');
  });
});
