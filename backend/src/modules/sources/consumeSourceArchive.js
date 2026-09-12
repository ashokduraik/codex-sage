/**
 * Reads the multipart `archive` part before idempotency hashing.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../platform/errors.js';
import { UPLOAD_MAX_ARCHIVE_BYTES } from './exclusions/exclusions.constants.js';
import {
  ARCHIVE_FIELD_NAME,
  UPLOAD_HASH_ALGORITHM,
} from './sources.constants.js';

/**
 * Collects a readable stream into a Buffer, enforcing the archive size cap.
 * @param {NodeJS.ReadableStream} stream Part stream.
 * @returns {Promise<Buffer>}
 * @throws {ApiError} SOURCE_ARCHIVE_TOO_LARGE
 */
async function readPartWithinCap(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > UPLOAD_MAX_ARCHIVE_BYTES) {
      stream.destroy?.();
      throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Consumes the zip archive part and sets request.body for idempotency hashing.
 * Opt-in via route `config.consumeSourceArchive: true`.
 * Must run before the Phase 12 idempotency preHandler.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {Promise<void>}
 */
export async function consumeSourceArchivePreHandler(request) {
  const config = request.routeOptions?.config;
  if (!config || config.consumeSourceArchive !== true) {
    return;
  }

  if (typeof request.file !== 'function') {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: ARCHIVE_FIELD_NAME, message: 'multipart archive is required' }],
    });
  }

  const part = await request.file();
  if (!part || part.fieldname !== ARCHIVE_FIELD_NAME) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: ARCHIVE_FIELD_NAME,
          message: `multipart field "${ARCHIVE_FIELD_NAME}" (zip) is required`,
        },
      ],
    });
  }

  const buffer = await readPartWithinCap(part.file);
  const contentSha256 = createHash(UPLOAD_HASH_ALGORITHM).update(buffer).digest('hex');

  request.sourceUpload = {
    buffer,
    contentSha256,
    filename: typeof part.filename === 'string' ? part.filename : null,
  };
  // Stable JSON body so Phase 12 hashes the archive identity, not an empty multipart body.
  request.body = { archiveSha256: contentSha256 };
}
