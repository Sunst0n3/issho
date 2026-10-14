import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UploadVoiceResponse } from '../../../shared/api.ts';
import { currentMember } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parseWith } from '../errors.ts';

export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

interface AudioFormat {
  ext: string;
  /** Checks the file's magic bytes, so what we later serve as audio really is audio. */
  matches: (bytes: Buffer) => boolean;
}

const ascii = (bytes: Buffer, start: number, text: string) =>
  bytes.subarray(start, start + text.length).toString('latin1') === text;

const FORMATS: Record<string, AudioFormat> = {
  'audio/webm': { ext: 'webm', matches: (b) => b.readUInt32BE(0) === 0x1a45dfa3 },
  'audio/mp4': { ext: 'm4a', matches: (b) => ascii(b, 4, 'ftyp') },
  'audio/ogg': { ext: 'ogg', matches: (b) => ascii(b, 0, 'OggS') },
  'audio/wav': { ext: 'wav', matches: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE') },
};

const ALIASES: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

const VoiceParamsSchema = z.object({ audioId: z.uuid() });

/** 'audio/webm;codecs=opus' → 'audio/webm' */
function canonicalType(mimetype: string): string {
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return ALIASES[base] ?? base;
}

export function voiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/voice', async (request, reply): Promise<UploadVoiceResponse> => {
    const member = currentMember(request);
    if (!request.isMultipart()) throw new HttpError(415, 'unsupported_media_type');

    const file = await request.file({ limits: { fileSize: MAX_VOICE_BYTES, files: 1, fields: 4 } });
    if (!file || file.fieldname !== 'audio') {
      file?.file.resume();
      throw new HttpError(400, 'audio_required');
    }
    const contentType = canonicalType(file.mimetype);
    const format = FORMATS[contentType];
    if (!format) {
      file.file.resume();
      throw new HttpError(415, 'unsupported_audio_type');
    }

    // Throws a 413 once the stream passes MAX_VOICE_BYTES.
    const bytes = await file.toBuffer();
    if (bytes.length < 12 || !format.matches(bytes)) throw new HttpError(415, 'unsupported_audio_type');

    const id = randomUUID();
    const fileName = `${id}.${format.ext}`;
    const filePath = path.join(ctx.voiceDir, fileName);
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    try {
      ctx.store.insertVoice({
        id,
        memberId: member.id,
        contentType,
        fileName,
        size: bytes.length,
        createdAt: ctx.now().toISOString(),
      });
    } catch (error) {
      await unlink(filePath).catch(() => {});
      throw error;
    }

    reply.code(201);
    return { audioId: id };
  });

  app.get('/api/voice/:audioId', async (request, reply) => {
    const { audioId } = parseWith(VoiceParamsSchema, request.params);
    const voice = ctx.store.getVoice(audioId);
    if (!voice) throw new HttpError(404, 'not_found');

    // The file name comes from our own database row, never from the URL.
    const filePath = path.join(ctx.voiceDir, voice.fileName);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'not_found');

    return reply
      .header('content-type', voice.contentType)
      .header('content-length', info.size)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(filePath));
  });
}
