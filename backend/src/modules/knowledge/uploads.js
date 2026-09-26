/**
 * knowledge/uploads.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent, buildAuditContextFromRequest } from '../access/index.js';
import { createPendingJob, findProjectById, transitionLifecycle } from '../masters/index.js';
import {
  ARCHIVE_FIELD_NAME,
  UPLOAD_HASH_ALGORITHM,
  buildSourceGridFsFilename,
  getSourceFilesBucket,
  markGridFsFilesOrphaned,
  insertSourceFiles,
  insertSourceVersion,
  setSourceVersionJobId,
  GRIDFS_SOURCE_BUCKET,
} from './sources.js';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fromBufferPromise } from 'yauzl';

// --- from sources/exclusions/exclusions.constants.js ---
/**
 * Exclusion ruleset v1 constants — caps, ignore lists, and allowlists.
 * Tunables live here (not env). Phase 24 persists EXCLUSION_RULESET_ID on SourceVersion.
 */

/** Recorded on SourceVersion so S2 can replay the same rules. */
export const EXCLUSION_RULESET_ID = 'exclusions.v1';

/**
 * Ensures a recorded ruleset id is known to this process.
 * @param {string} rulesetId Value persisted on SourceVersion.
 * @returns {void}
 */
export function assertKnownExclusionRulesetId(rulesetId) {
  if (rulesetId !== EXCLUSION_RULESET_ID) {
    throw ApiError.fromCode('SOURCE_UNKNOWN_EXCLUSION_RULESET');
  }
}

/** Files larger than this are stored but excluded from the code graph (1 MiB). */
export const GRAPH_FILE_MAX_BYTES = 1_048_576;

/** Maximum accepted archive size before listing (500 MiB). */
export const UPLOAD_MAX_ARCHIVE_BYTES = 524_288_000;

/** Maximum number of zip entries to list before failing closed. */
export const UPLOAD_MAX_ENTRY_COUNT = 100_000;

/**
 * Runtime archive caps. Production reads the defaults; tests may override
 * and must restore. Exported constants stay the documented defaults.
 */
export const uploadArchiveLimits = {
  maxArchiveBytes: UPLOAD_MAX_ARCHIVE_BYTES,
  maxEntryCount: UPLOAD_MAX_ENTRY_COUNT,
};

/** Directory prefixes skipped before GridFS (solution §4.2). */
export const IGNORED_PATH_PREFIXES = Object.freeze([
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
]);

/** Image extensions skipped entirely (not stored). */
export const IGNORED_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svg',
]);

/** Exact basenames always skipped. */
export const IGNORED_BASENAMES = Object.freeze(['.DS_Store']);

/** Suffixes for minified assets skipped as junk. */
export const IGNORED_FILE_SUFFIXES = Object.freeze(['.min.js', '.min.css']);

/** Code extensions accepted for storage and (when under size) graph indexing. */
export const ACCEPTED_CODE_EXTENSIONS = Object.freeze([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
]);

/** Documentation extensions accepted for storage / FTS. */
export const ACCEPTED_DOC_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt']);

/** Config extensions accepted for bounded reads (not assumed graph nodes). */
export const ACCEPTED_CONFIG_EXTENSIONS = Object.freeze([
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env.example',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
]);

/** Exact config basenames (may carry compound extensions). */
export const ACCEPTED_CONFIG_BASENAMES = Object.freeze([
  '.prettierrc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
]);

// --- from sources/exclusions/pathSafety.js ---
/**
 * Path normalization and zip-slip / duplicate-path safety checks.
 */
/**
 * Normalizes an archive entry path: backslashes to `/`, strip leading `./`,
 * collapse duplicate slashes, and drop a trailing slash for file comparisons.
 * @param {string} rawPath Raw zip entry path.
 * @returns {string} Normalized relative path using `/`.
 */
export function normalizeArchivePath(rawPath) {
  if (typeof rawPath !== 'string') {
    return '';
  }
  let path = rawPath.replace(/\\/g, '/');
  path = path.replace(/^\.\/+/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/**
 * Returns true when the normalized path is absolute, contains `..`, or has a
 * Windows drive prefix.
 * @param {string} normalizedPath Path already passed through {@link normalizeArchivePath}.
 * @returns {boolean}
 */
export function isUnsafeArchivePath(normalizedPath) {
  if (!normalizedPath) {
    return true;
  }
  if (normalizedPath.startsWith('/')) {
    return true;
  }
  if (/^[a-zA-Z]:/.test(normalizedPath)) {
    return true;
  }
  const segments = normalizedPath.split('/');
  return segments.some((segment) => segment === '..');
}

/**
 * Asserts that a normalized path is safe for extraction; throws SOURCE_ZIP_SLIP otherwise.
 * @param {string} normalizedPath Normalized entry path.
 * @returns {void}
 * @throws {ApiError}
 */
export function assertSafeArchivePath(normalizedPath) {
  if (isUnsafeArchivePath(normalizedPath)) {
    throw ApiError.fromCode('SOURCE_ZIP_SLIP');
  }
}

/**
 * Tracks seen normalized paths and throws on collision.
 * @returns {{ remember: (normalizedPath: string) => void }}
 */
export function createDuplicatePathGuard() {
  const seen = new Set();
  return {
    /**
     * @param {string} normalizedPath
     * @returns {void}
     * @throws {ApiError}
     */
    remember(normalizedPath) {
      if (seen.has(normalizedPath)) {
        throw ApiError.fromCode('SOURCE_ZIP_SLIP');
      }
      seen.add(normalizedPath);
    },
  };
}

// --- from sources/exclusions/pathDecision.js ---
/**
 * Per-entry accept / skip / exclude-from-graph decisions for upload paths.
 */
/**
 * Returns the final path segment of a normalized path.
 * @param {string} normalizedPath
 * @returns {string}
 */
function basenameOf(normalizedPath) {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
}

/**
 * True when any path segment (as a directory prefix) matches an ignored prefix.
 * @param {string} normalizedPath
 * @returns {boolean}
 */
function matchesIgnoredDirectory(normalizedPath) {
  const withSlash = normalizedPath.endsWith('/')
    ? normalizedPath
    : `${normalizedPath}/`;
  for (const prefix of IGNORED_PATH_PREFIXES) {
    if (withSlash.startsWith(prefix) || withSlash.includes(`/${prefix}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Lowercased extension including the leading dot, or empty string.
 * @param {string} basename
 * @returns {string}
 */
function extensionOf(basename) {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return basename.slice(dot).toLowerCase();
}

/**
 * True when the path is an allowlisted code, doc, or config file.
 * @param {string} basename
 * @param {string} extension
 * @returns {boolean}
 */
function isAllowlistedSourceFile(basename, extension) {
  if (ACCEPTED_CONFIG_BASENAMES.includes(basename)) {
    return true;
  }
  if (ACCEPTED_CODE_EXTENSIONS.includes(extension)) {
    return true;
  }
  if (ACCEPTED_DOC_EXTENSIONS.includes(extension)) {
    return true;
  }
  if (ACCEPTED_CONFIG_EXTENSIONS.includes(extension)) {
    return true;
  }
  // Compound config extensions such as `.env.example` (extensionOf returns `.example`).
  const basenameLower = basename.toLowerCase();
  return ACCEPTED_CONFIG_EXTENSIONS.some((ext) => basenameLower.endsWith(ext));
}

/**
 * Decides whether an upload entry is accepted, skipped, or stored but excluded
 * from the code graph.
 * @param {{ path: string, uncompressedSize: number }} entry Entry metadata.
 * @returns {{ decision: 'accept' | 'accept_excluded_from_graph' | 'skip', reasonCode?: string }}
 */
export function evaluateUploadEntry(entry) {
  const normalizedPath = normalizeArchivePath(entry.path);
  const basename = basenameOf(normalizedPath);
  const basenameLower = basename.toLowerCase();
  const extension = extensionOf(basename);

  if (matchesIgnoredDirectory(normalizedPath)) {
    return { decision: 'skip', reasonCode: 'ignored_directory' };
  }

  if (
    IGNORED_BASENAMES.includes(basename) ||
    IGNORED_FILE_SUFFIXES.some((suffix) => basenameLower.endsWith(suffix))
  ) {
    return { decision: 'skip', reasonCode: 'ignored_file' };
  }

  if (IGNORED_IMAGE_EXTENSIONS.includes(extension)) {
    return { decision: 'skip', reasonCode: 'ignored_image' };
  }

  if (!isAllowlistedSourceFile(basename, extension)) {
    return { decision: 'skip', reasonCode: 'unsupported_extension' };
  }

  const size =
    typeof entry.uncompressedSize === 'number' && Number.isFinite(entry.uncompressedSize)
      ? entry.uncompressedSize
      : 0;

  if (size > GRAPH_FILE_MAX_BYTES) {
    return {
      decision: 'accept_excluded_from_graph',
      reasonCode: 'file_too_large',
    };
  }

  return { decision: 'accept' };
}

/**
 * Applies exclusion rules to listed zip entries and returns the Phase 23 result object.
 * Throws when nothing remains after exclusions (fail closed for Phase 24).
 * @param {Array<{ path: string, uncompressedSize: number }>} entries
 * @returns {{
 *   rulesetId: string,
 *   accepted: Array<{ path: string, size: number, excludedFromGraph: boolean, exclusionReason?: string }>,
 *   skipped: Array<{ path: string, reasonCode: string }>,
 *   emptyAfterExclude: false
 * }}
 * @throws {ApiError} SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS when no accepted paths remain.
 */
export function summarizeInspection(entries) {
  /** @type {Array<{ path: string, size: number, excludedFromGraph: boolean, exclusionReason?: string }>} */
  const accepted = [];
  /** @type {Array<{ path: string, reasonCode: string }>} */
  const skipped = [];

  for (const entry of entries) {
    const { decision, reasonCode } = evaluateUploadEntry(entry);
    if (decision === 'skip') {
      skipped.push({ path: entry.path, reasonCode: reasonCode ?? 'skipped' });
      continue;
    }
    if (decision === 'accept_excluded_from_graph') {
      accepted.push({
        path: entry.path,
        size: entry.uncompressedSize,
        excludedFromGraph: true,
        exclusionReason: reasonCode ?? 'file_too_large',
      });
      continue;
    }
    accepted.push({
      path: entry.path,
      size: entry.uncompressedSize,
      excludedFromGraph: false,
    });
  }

  if (accepted.length === 0) {
    throw ApiError.fromCode('SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS');
  }

  return {
    rulesetId: EXCLUSION_RULESET_ID,
    accepted,
    skipped,
    emptyAfterExclude: false,
  };
}

// --- from sources/exclusions/zipInspect.js ---
/**
 * Zip metadata inspection: integrity, zip-slip, entry listing (no file bytes retained).
 */
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
    if (total > uploadArchiveLimits.maxArchiveBytes) {
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
    if (input.length > uploadArchiveLimits.maxArchiveBytes) {
      throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > uploadArchiveLimits.maxArchiveBytes) {
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
      if (entries.length >= uploadArchiveLimits.maxEntryCount) {
        throw ApiError.fromCode('SOURCE_ARCHIVE_TOO_LARGE');
      }

      const rawName =
        typeof entry.fileName === 'string' ? entry.fileName : String(entry.fileName ?? '');

      // Directory markers are optional metadata; skip them for decisioning.
      if (rawName.endsWith('/')) {
        continue;
      }

      if (((entry.generalPurposeBitFlag ?? 0) & 0x1) === 0x1) {
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

// --- from sources/consumeSourceArchive.js ---
/**
 * Reads the multipart `archive` part before idempotency hashing.
 */
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
    if (total > uploadArchiveLimits.maxArchiveBytes) {
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

// --- from sources/upload.service.js ---
/**
 * Upload persistence: validate zip, store accepted bytes in GridFS, enqueue ingest.
 */
/**
 * Classifies an accepted path as code, config, or doc.
 * @param {string} normalizedPath Relative archive path.
 * @returns {'code' | 'config' | 'doc'}
 */
export function kindForSourcePath(normalizedPath) {
  const basename = basenameOf(normalizedPath);
  const basenameLower = basename.toLowerCase();
  const extension = extensionOf(basename);

  if (
    ACCEPTED_CONFIG_BASENAMES.includes(basename) ||
    ACCEPTED_CONFIG_EXTENSIONS.includes(extension) ||
    ACCEPTED_CONFIG_EXTENSIONS.some((ext) => basenameLower.endsWith(ext))
  ) {
    return 'config';
  }
  if (ACCEPTED_DOC_EXTENSIONS.includes(extension)) {
    return 'doc';
  }
  if (ACCEPTED_CODE_EXTENSIONS.includes(extension)) {
    return 'code';
  }
  return 'code';
}

/**
 * Creates a transform that updates a hash and counts bytes while passing data through.
 * @param {import('node:crypto').Hash} hash Hash instance.
 * @param {{ byteLength: number }} counter Mutable byte counter.
 * @returns {Transform}
 */
function createHashingPassThrough(hash, counter) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      counter.byteLength += buf.length;
      callback(null, buf);
    },
  });
}

/**
 * Opens a zip from buffer and streams only the accepted paths into GridFS.
 * Skipped paths never call openUploadStream.
 * @param {{
 *   archiveBuffer: Buffer,
 *   accepted: Array<{
 *     path: string,
 *     size: number,
 *     excludedFromGraph: boolean,
 *     exclusionReason?: string,
 *   }>,
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   rewritePath?: (normalizedPath: string) => string,
 * }} input Scope + accepted set.
 * @returns {Promise<{
 *   files: Array<{
 *     path: string,
 *     sha256: string,
 *     byteLength: number,
 *     kind: 'code' | 'config' | 'doc',
 *     gridFsId: import('mongoose').Types.ObjectId,
 *     excludedFromGraph: boolean,
 *     exclusionReason: string | null,
 *   }>,
 *   gridFsIds: import('mongoose').Types.ObjectId[],
 * }>}
 */
export async function storeAcceptedZipEntries(input) {
  const acceptedByPath = new Map(input.accepted.map((entry) => [entry.path, entry]));
  const remaining = new Set(acceptedByPath.keys());
  /** @type {import('mongoose').Types.ObjectId[]} */
  const gridFsIds = [];
  /** @type {Array<{
   *   path: string,
   *   sha256: string,
   *   byteLength: number,
   *   kind: 'code' | 'config' | 'doc',
   *   gridFsId: import('mongoose').Types.ObjectId,
   *   excludedFromGraph: boolean,
   *   exclusionReason: string | null,
   * }>} */
  const files = [];

  const bucket = getSourceFilesBucket();
  let zipfile;
  try {
    zipfile = await fromBufferPromise(input.archiveBuffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch {
    throw ApiError.fromCode('SOURCE_ZIP_INTEGRITY');
  }

  try {
    for await (const entry of zipfile.eachEntry()) {
      const rawName =
        typeof entry.fileName === 'string' ? entry.fileName : String(entry.fileName ?? '');
      if (rawName.endsWith('/')) {
        continue;
      }

      const normalized = normalizeArchivePath(rawName);
      const path =
        typeof input.rewritePath === 'function' ? input.rewritePath(normalized) : normalized;
      const accepted = acceptedByPath.get(path);
      if (!accepted) {
        continue;
      }
      remaining.delete(path);

      const hash = createHash(UPLOAD_HASH_ALGORITHM);
      const counter = { byteLength: 0 };
      const filename = buildSourceGridFsFilename({
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId: input.sourceVersionId,
        path,
      });

      const uploadStream = bucket.openUploadStream(filename, {
        metadata: {
          orgId: input.orgId,
          projectId: input.projectId,
          sourceVersionId: input.sourceVersionId,
          path,
        },
      });
      gridFsIds.push(uploadStream.id);

      try {
        const readStream = await zipfile.openReadStreamPromise(entry);
        await pipeline(readStream, createHashingPassThrough(hash, counter), uploadStream);
      } catch (error) {
        await markGridFsFilesOrphaned(gridFsIds);
        throw error;
      }

      const sha256 = hash.digest('hex');
      const db = mongoose.connection.db;
      if (db) {
        await db
          .collection(`${GRIDFS_SOURCE_BUCKET}.files`)
          .updateOne({ _id: uploadStream.id }, { $set: { 'metadata.sha256': sha256 } });
      }

      files.push({
        path,
        sha256,
        byteLength: counter.byteLength,
        kind: kindForSourcePath(path),
        gridFsId: uploadStream.id,
        excludedFromGraph: accepted.excludedFromGraph,
        exclusionReason: accepted.exclusionReason ?? null,
      });
    }
  } finally {
    zipfile.close();
  }

  if (remaining.size > 0) {
    await markGridFsFilesOrphaned(gridFsIds);
    throw ApiError.fromCode('SOURCE_ZIP_INTEGRITY');
  }

  return { files, gridFsIds };
}

/**
 * Persists a validated upload: GridFS + SourceVersion/SourceFile + pending ingest job.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   archiveBuffer: Buffer,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Upload context.
 * @returns {Promise<{ sourceVersionId: string, jobId: string }>}
 */
export async function persistSourceUpload(input) {
  const { entries } = await inspectZip(input.archiveBuffer);
  const inspection = summarizeInspection(entries);

  const sourceVersionId = new mongoose.Types.ObjectId().toString();
  /** @type {import('mongoose').Types.ObjectId[]} */
  let gridFsIds = [];

  try {
    const stored = await storeAcceptedZipEntries({
      archiveBuffer: input.archiveBuffer,
      accepted: inspection.accepted,
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
    });
    gridFsIds = stored.gridFsIds;

    const fileCounts = {
      accepted: inspection.accepted.length,
      skipped: inspection.skipped.length,
      excludedFromGraph: inspection.accepted.filter((row) => row.excludedFromGraph).length,
    };

    const session = await mongoose.startSession();
    let jobId;
    try {
      await session.withTransaction(async () => {
        await insertSourceVersion(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            sourceVersionId,
            exclusionRulesetId: inspection.rulesetId,
            createdBy: input.actorUserId,
            fileCounts,
          },
          { session },
        );

        await insertSourceFiles(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            sourceVersionId,
            createdBy: input.actorUserId,
            files: stored.files,
          },
          { session },
        );

        const pending = await createPendingJob(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            jobType: 'ingest',
            createdBy: input.actorUserId,
            correlationId: input.correlationId,
            sourceVersionId,
          },
          { session },
        );
        jobId = pending.jobId;

        await setSourceVersionJobId(
          {
            orgId: input.orgId,
            sourceVersionId,
            jobId,
            updatedBy: input.actorUserId,
          },
          { session },
        );

        const project = await findProjectById(input.orgId, input.projectId, { session });
        if (project && project.lifecycleStatus === 'awaiting_source') {
          await transitionLifecycle({
            orgId: input.orgId,
            projectId: input.projectId,
            from: 'awaiting_source',
            to: 'source_received',
            source: 'api',
            actorUserId: input.actorUserId,
            reasonCode: 'source_uploaded',
            session,
          });
        }
      });
    } finally {
      await session.endSession();
    }

    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'source.upload',
        resourceType: 'source',
        resourceId: sourceVersionId,
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: {
          projectId: input.projectId,
          sourceVersionId,
          jobId,
          acceptedCount: fileCounts.accepted,
          skippedCount: fileCounts.skipped,
          excludedFromGraphCount: fileCounts.excludedFromGraph,
        },
      },
      { log: input.log },
    );

    return { sourceVersionId, jobId };
  } catch (error) {
    await markGridFsFilesOrphaned(gridFsIds);
    throw error;
  }
}

// --- from sources/upload.routes.js ---
/**
 * Source upload HTTP routes under `/api/v1`.
 */
/**
 * Registers source upload routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourceUploadRoutes(app) {
  app.post(
    '/projects/:projectId/sources',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
        consumeSourceArchive: true,
      },
      preHandler: requireProjectPermission('sources.upload'),
    },
    async (request, reply) => {
      // consumeSourceArchivePreHandler always attaches buffer when this route runs.
      const upload = request.sourceUpload;
      const audit = buildAuditContextFromRequest(request);
      const result = await persistSourceUpload({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        actorUserId: request.projectScope.userId,
        correlationId: audit.correlationId,
        archiveBuffer: upload.buffer,
        ip: audit.ip,
        userAgent: audit.userAgent,
        log: request.log,
      });

      return reply.code(202).send(result);
    },
  );
}
