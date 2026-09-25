/**
 * Upload persistence: validate zip, store accepted bytes in GridFS, enqueue ingest.
 */
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import mongoose from 'mongoose';
import { fromBufferPromise } from 'yauzl';
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { createPendingJob } from '../jobs/index.js';
import { findProjectById, transitionLifecycle } from '../projects/index.js';
import {
  ACCEPTED_CODE_EXTENSIONS,
  ACCEPTED_CONFIG_BASENAMES,
  ACCEPTED_CONFIG_EXTENSIONS,
  ACCEPTED_DOC_EXTENSIONS,
} from './exclusions/exclusions.constants.js';
import { inspectZip, summarizeInspection } from './exclusions/index.js';
import { normalizeArchivePath } from './exclusions/pathSafety.js';
import {
  buildSourceGridFsFilename,
  getSourceFilesBucket,
  markGridFsFilesOrphaned,
} from './gridfs.js';
import {
  insertSourceFiles,
  insertSourceVersion,
  setSourceVersionJobId,
} from './sources.repository.js';
import { GRIDFS_SOURCE_BUCKET, UPLOAD_HASH_ALGORITHM } from './sources.constants.js';

/**
 * Returns the final path segment.
 * @param {string} normalizedPath Relative path.
 * @returns {string}
 */
function basenameOf(normalizedPath) {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
}

/**
 * Lowercased extension including the leading dot, or empty string.
 * @param {string} basename File basename.
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
      });
    } finally {
      await session.endSession();
    }

    const project = await findProjectById(input.orgId, input.projectId);
    if (project && project.lifecycleStatus === 'awaiting_source') {
      await transitionLifecycle({
        orgId: input.orgId,
        projectId: input.projectId,
        from: 'awaiting_source',
        to: 'source_received',
        source: 'api',
        actorUserId: input.actorUserId,
        reasonCode: 'source_uploaded',
      });
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
