import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ChatMessage, RegisterResponse, UploadVoiceResponse } from '../../shared/api.ts';
import { MAX_VOICE_BYTES } from '../src/routes/voice.ts';
import { bearer, createTestServer, multipart, WEBM, type TestServer } from './helpers.ts';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(40, 1)]);

describe('voice', () => {
  let server: TestServer;
  let carter: RegisterResponse;
  let aiko: RegisterResponse;

  before(async () => {
    server = await createTestServer();
    carter = await server.register('Carter');
    aiko = await server.register('Aiko');
  });
  after(() => server.close());

  async function upload(token: string, bytes: Buffer, type: string, field = 'audio') {
    const body = await multipart(field, bytes, type);
    return server.app.inject({
      method: 'POST',
      url: '/api/voice',
      headers: { ...bearer(token), 'content-type': body.contentType },
      payload: body.payload,
    });
  }

  it('stores a recording and serves it back', async () => {
    const res = await upload(carter.deviceToken, WEBM, 'audio/webm;codecs=opus');
    assert.equal(res.statusCode, 201);
    const { audioId } = res.json<UploadVoiceResponse>();
    assert.match(audioId, /^[0-9a-f-]{36}$/);

    const files = await readdir(path.join(server.dataDir, 'voice'));
    assert.deepEqual(files, [`${audioId}.webm`]);

    // Either member can play it.
    const get = await server.app.inject({ method: 'GET', url: `/api/voice/${audioId}`, headers: bearer(aiko.deviceToken) });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['content-type'], 'audio/webm');
    assert.match(String(get.headers['cache-control']), /immutable/);
    assert.deepEqual(get.rawPayload, WEBM);
  });

  it('accepts audio/mp4 from iOS', async () => {
    const res = await upload(aiko.deviceToken, MP4, 'audio/mp4');
    assert.equal(res.statusCode, 201);
    const get = await server.app.inject({
      method: 'GET',
      url: `/api/voice/${res.json<UploadVoiceResponse>().audioId}`,
      headers: bearer(aiko.deviceToken),
    });
    assert.equal(get.headers['content-type'], 'audio/mp4');
  });

  it('rejects other types, fake audio, wrong fields and non-multipart bodies', async () => {
    const mpeg = await upload(carter.deviceToken, WEBM, 'audio/mpeg');
    assert.equal(mpeg.statusCode, 415);
    assert.deepEqual(mpeg.json(), { error: 'unsupported_audio_type' });

    const html = await upload(carter.deviceToken, Buffer.from('<html><script>alert(1)</script></html>'), 'audio/webm');
    assert.equal(html.statusCode, 415);

    const wrongField = await upload(carter.deviceToken, WEBM, 'audio/webm', 'file');
    assert.equal(wrongField.statusCode, 400);
    assert.deepEqual(wrongField.json(), { error: 'audio_required' });

    const json = await server.app.inject({
      method: 'POST',
      url: '/api/voice',
      headers: bearer(carter.deviceToken),
      payload: { audio: 'x' },
    });
    assert.equal(json.statusCode, 415);
  });

  it('accepts recordings up to 2 MB', async () => {
    const atLimit = Buffer.concat([WEBM, Buffer.alloc(MAX_VOICE_BYTES - WEBM.length)]);
    const res = await upload(carter.deviceToken, atLimit, 'audio/webm');
    assert.equal(res.statusCode, 201);
  });

  it('rejects recordings over 2 MB', async () => {
    const big = Buffer.concat([WEBM, Buffer.alloc(MAX_VOICE_BYTES)]);
    const res = await upload(carter.deviceToken, big, 'audio/webm');
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: 'too_large' });
  });

  it('validates audio ids', async () => {
    const bad = await server.app.inject({ method: 'GET', url: '/api/voice/..%2F..%2Fissho.db', headers: bearer(carter.deviceToken) });
    assert.equal(bad.statusCode, 400);
    const missing = await server.app.inject({
      method: 'GET',
      url: `/api/voice/${crypto.randomUUID()}`,
      headers: bearer(carter.deviceToken),
    });
    assert.equal(missing.statusCode, 404);
  });

  it('sends voice messages that reference the sender’s own recording', async () => {
    const { audioId } = (await upload(carter.deviceToken, WEBM, 'audio/webm')).json<UploadVoiceResponse>();

    const sent = await server.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: bearer(carter.deviceToken),
      payload: { clientId: 'voice-1', kind: 'voice', text: '', transcript: 'おはよう', audioId },
    });
    assert.equal(sent.statusCode, 201);
    const message = sent.json<ChatMessage>();
    assert.equal(message.audioId, audioId);
    assert.equal(message.transcript, 'おはよう');

    const stolen = await server.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: bearer(aiko.deviceToken),
      payload: { clientId: 'voice-2', kind: 'voice', text: '', audioId },
    });
    assert.equal(stolen.statusCode, 400);
    assert.deepEqual(stolen.json(), { error: 'unknown_audio' });
  });
});
