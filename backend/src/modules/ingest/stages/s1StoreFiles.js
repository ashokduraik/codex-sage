/**
 * S1 store_files — reconcile SourceFile rows against GridFS (not a second write).
 */
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import { INGEST_FILE_BATCH_SIZE } from '../ingest.counters.js';
import { buildFilesIdentifiedEvent } from '../ingest.events.js';
import {
  SOURCE_FILE_STATE_CORRUPT,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_STORED,
  findSourceGridFsFileById,
  listSourceFilesOrdered,
  markOrphanGridFsObjects,
  updateSourceFileState,
} from '../ingest.repository.js';

/** Above this share of failed files S1 fails as temporary instead of partial success. */
export const INGEST_MAX_FAILED_FILE_RATIO = 0.05;

/**
 * Runs S1 store_files with path-ordered cursor resume.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: null,
 *   warnings: object[],
 * }>}
 */
export async function runStoreFilesStage(ctx) {
  const resumePath =
    typeof ctx.checkpoint?.cursor?.lastPath === 'string'
      ? ctx.checkpoint.cursor.lastPath
      : null;

  const allFiles = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  ctx.counters.filesTotal = allFiles.length;

  const knownGridFsIds = new Set(
    allFiles.filter((file) => file.gridFsId).map((file) => String(file.gridFsId)),
  );

  // Restore counters for paths already reconciled on a prior attempt.
  if (resumePath) {
    for (const file of allFiles) {
      if (file.path > resumePath) {
        break;
      }
      ctx.counters.filesProcessed += 1;
      ctx.counters.bytesProcessed += file.byteLength ?? 0;
      if (
        file.fileState === SOURCE_FILE_STATE_MISSING ||
        file.fileState === SOURCE_FILE_STATE_CORRUPT
      ) {
        ctx.counters.filesFailed += 1;
      }
    }
  }

  const files = resumePath
    ? allFiles.filter((file) => file.path > resumePath)
    : allFiles;

  /** @type {object[]} */
  const warnings = [];
  let lastPath = resumePath;

  for (const file of files) {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      if (lastPath) {
        await ctx.saveInProgressCursor({ lastPath }, 'store_files');
        await ctx.saveProgress(true);
      }
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    const gridFs = file.gridFsId ? await findSourceGridFsFileById(file.gridFsId) : null;

    if (!gridFs) {
      await updateSourceFileState({
        orgId: ctx.scope.orgId,
        sourceFileId: file._id,
        fileState: SOURCE_FILE_STATE_MISSING,
      });
      ctx.counters.filesFailed += 1;
      warnings.push({ code: 'SOURCE_FILE_MISSING', path: file.path });
    } else {
      const lengthMismatch = gridFs.length !== file.byteLength;
      const hashMismatch =
        !gridFs.sha256 || gridFs.sha256.toLowerCase() !== String(file.sha256).toLowerCase();
      if (lengthMismatch || hashMismatch) {
        await updateSourceFileState({
          orgId: ctx.scope.orgId,
          sourceFileId: file._id,
          fileState: SOURCE_FILE_STATE_CORRUPT,
        });
        ctx.counters.filesFailed += 1;
        warnings.push({ code: 'SOURCE_FILE_CORRUPT', path: file.path });
      } else if (file.fileState !== SOURCE_FILE_STATE_STORED) {
        await updateSourceFileState({
          orgId: ctx.scope.orgId,
          sourceFileId: file._id,
          fileState: SOURCE_FILE_STATE_STORED,
        });
      }
      ctx.counters.bytesProcessed += file.byteLength ?? 0;
    }

    ctx.counters.filesProcessed += 1;
    lastPath = file.path;
    ctx.noteFileProcessed();

    // Persist cursor on the same cadence as counter flushes (batch / interval).
    const beforeFlush = ctx.counters.filesProcessed;
    await ctx.saveProgress(false);
    // saveProgress may no-op when throttled; always keep in-memory cursor, and
    // force a cursor write every INGEST_FILE_BATCH_SIZE files.
    if (beforeFlush % INGEST_FILE_BATCH_SIZE === 0) {
      await ctx.saveInProgressCursor({ lastPath }, 'store_files');
    } else {
      ctx.checkpoint = {
        lastCompletedStage: ctx.checkpoint?.lastCompletedStage ?? 'validate_upload',
        cursor: { lastPath },
      };
    }
  }

  if (lastPath) {
    await ctx.saveInProgressCursor({ lastPath }, 'store_files');
  }

  await markOrphanGridFsObjects({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    knownGridFsIds,
  });

  const total = Math.max(ctx.counters.filesTotal, 1);
  const failedRatio = ctx.counters.filesFailed / total;
  if (failedRatio > INGEST_MAX_FAILED_FILE_RATIO) {
    await ctx.saveProgress(true);
    throw createJobFailureError({
      failureClass: 'temporary',
      code: 'INGEST_TOO_MANY_FAILED_FILES',
      message: 'Too many files failed integrity checks. The job will retry from its checkpoint.',
    });
  }

  await ctx.emitEvent(
    buildFilesIdentifiedEvent({
      filesProcessed: ctx.counters.filesProcessed,
      filesFailed: ctx.counters.filesFailed,
    }),
  );
  await ctx.saveProgress(true);

  return {
    outcome: ctx.counters.filesFailed > 0 ? 'completed_with_warnings' : 'completed',
    cursor: null,
    warnings,
  };
}
