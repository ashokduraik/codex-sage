/**
 * Zip metadata inspection: integrity, zip-slip, entry listing (no file bytes retained).
 */
import { Readable } from 'node:stream';
import { fromBufferPromise } from 'yauzl';
import { ApiError } from '../../../platform/errors.js';
import {
  UPLOAD_MAX_ARCHIVE_BYTES,
  UPLOAD_MAX_ENTRY_COUNT,
} from './exclusions.constants.js';
import {
  assertSafeArchivePath,
  createDuplicatePathGuard,
  normalizeArchivePath,
} from './pathSafety.js';

/**
 * True when the zip entry is marked encrypted (general-purpose bit 0).
 * @param {{ generalPurposeBitFlag?: number }} entry
 * @returns {boolean}
 */
function isEncryptedEntry(entry) {
  return ((entry.generalPurposeBitFlag ?? 0) & 0x1) === 0x1;
}

/**
 * Collects a readable stream into a Buffer, failing if it exceeds the archive cap.
 * @param {Readable} stream
 * @returns {Promise<Buffer>}
 * @throws {ApiError}
 */
async function readStreamWithinArchiveCap(stream) {
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
 * Resolves inspectZip input to a Buffer within size limits.
 * @param {Buffer | Uint8Array | Readable} input
 * @returns {Promise<Buffer>}
 * @throws {ApiError}
 */
async function resolveArchiveBuffer(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length > UPLOAD_MAX_ARCHIVE_BYTES) {
      throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > UPLOAD_MAX_ARCHIVE_BYTES) {
      throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
    }
    return Buffer.from(input);
  }
  if (input instanceof Readable || (input && typeof input[Symbol.asyncIterator] === 'function')) {
    return readStreamWithinArchiveCap(/** @type {Readable} */ (input));
  }
  throw ApiError.fromCode('SOURCE_ZIP_INTEGRITY');
}

/**
 * Maps a yauzl / IO failure to a catalog ApiError.
 * @param {unknown} error
 * @returns {ApiError}
 */
function mapZipOpenError(error) {
  if (error instanceof ApiError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid filename|absolute path|\\\\|\.\./i.test(message)) {
    return ApiError.fromCode('SOURCE_ZIP_SLIP');
  }
  return ApiError.fromCode('SOURCE_ZIP_INTEGRITY');
}

/**
 * Lists zip entry paths and uncompressed sizes without retaining file bytes.
 * Rejects zip-slip, duplicates, encryption, truncated archives, and size/count caps.
 * @param {Buffer | Uint8Array | Readable} input Archive bytes or a readable stream.
 * @returns {Promise<{ entries: Array<{ path: string, uncompressedSize: number }>, integrity: 'ok' }>}
 * @throws {ApiError}
 */
export async function inspectZip(input) {
  const buffer = await resolveArchiveBuffer(input);

  let zipfile;
  try {
    zipfile = await fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch (error) {
    throw mapZipOpenError(error);
  }

  const duplicateGuard = createDuplicatePathGuard();
  /** @type {Array<{ path: string, uncompressedSize: number }>} */
  const entries = [];

  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entries.length >= UPLOAD_MAX_ENTRY_COUNT) {
        throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
      }

      const rawName =
        typeof entry.fileName === 'string' ? entry.fileName : String(entry.fileName ?? '');

      // Directory markers are optional metadata; skip them for decisioning.
      if (rawName.endsWith('/')) {
        continue;
      }

      if (isEncryptedEntry(entry)) {
        throw ApiError.fromCode('SOURCE_ZIP_INTEGRITY');
      }

      const normalizedPath = normalizeArchivePath(rawName);
      assertSafeArchivePath(normalizedPath);
      duplicateGuard.remember(normalizedPath);

      entries.push({
        path: normalizedPath,
        uncompressedSize: entry.uncompressedSize ?? 0,
      });
    }
  } catch (error) {
    throw mapZipOpenError(error);
  } finally {
    zipfile.close();
  }

  return { entries, integrity: 'ok' };
}
