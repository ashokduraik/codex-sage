/**
 * S3 materialize_docs — recreate workspace tree and index document sections.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../../platform/config.js';
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import {
  copySectionsForPaths,
  insertDocumentSections,
  isDocumentPath,
  parseDocumentSections,
  softDeleteSectionsForPath,
  softDeleteSectionsForVersion,
} from '../../documents/index.js';
import {
  deleteWorkspaceRelativePath,
  materializeGridFsFileToDisk,
  resetProjectWorkspaceSubtree,
  resolveProjectWorkspacePath,
  resolveSafeWorkspaceFilePath,
} from '../../sources/index.js';
import {
  buildDocumentationIdentifiedEvent,
  buildWorkspaceMaterializedEvent,
} from '../ingest.events.js';
import {
  SOURCE_FILE_STATE_STORED,
  listSourceFilesOrdered,
} from '../ingest.repository.js';

/** Files processed between intra-stage cursor flushes. */
export const WORKSPACE_MATERIALIZE_BATCH_SIZE = 50;

/**
 * Resolves WORKSPACE_ROOT from carry override or validated application config.
 * @param {object} ctx IngestStageContext.
 * @returns {string} Absolute workspace root.
 */
function resolveWorkspaceRoot(ctx) {
  if (
    typeof ctx.carry?.workspaceRoot === 'string' &&
    path.isAbsolute(ctx.carry.workspaceRoot)
  ) {
    return path.resolve(ctx.carry.workspaceRoot);
  }
  return loadConfig().workspace.root;
}

/**
 * Maps a thrown value to a temporary workspace IO failure when appropriate.
 * @param {unknown} err Thrown value.
 * @returns {Error & { failureClass: string, code: string } | null}
 */
function temporaryIoFailureOrNull(err) {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String(/** @type {{ code?: unknown }} */ (err).code)
      : '';
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
    return createJobFailureError({
      failureClass: 'temporary',
      code: 'WORKSPACE_IO_ERROR',
      message: 'The workspace volume is not writable or is out of space.',
    });
  }
  return null;
}

/**
 * Flushes the path cursor when the batch window is full.
 * @param {object} ctx IngestStageContext.
 * @param {string | null} lastPath Last fully written path.
 * @param {number} sinceBatch Files since last cursor flush.
 * @returns {Promise<number>} Reset or unchanged batch counter.
 */
async function maybeFlushCursor(ctx, lastPath, sinceBatch) {
  if (lastPath && sinceBatch >= WORKSPACE_MATERIALIZE_BATCH_SIZE) {
    await ctx.saveInProgressCursor({ path: lastPath }, 'materialize_docs');
    await ctx.saveProgress(false);
    return 0;
  }
  await ctx.saveProgress(false);
  return sinceBatch;
}

/**
 * Runs S3 materialize_docs with path-ordered cursor resume.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: null,
 *   warnings: object[],
 * }>}
 */
export async function runMaterializeDocsStage(ctx) {
  const workspaceRoot = resolveWorkspaceRoot(ctx);

  let workspacePath;
  try {
    workspacePath = resolveProjectWorkspacePath(
      workspaceRoot,
      ctx.scope.orgId,
      ctx.scope.projectId,
    );
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String(/** @type {{ code?: unknown }} */ (err).code)
        : 'WORKSPACE_PATH_UNSAFE';
    throw createJobFailureError({
      failureClass: 'permanent',
      code,
      message: 'Workspace path resolution failed for this job scope.',
    });
  }
  ctx.carry.workspacePath = workspacePath;

  const resumePath =
    typeof ctx.checkpoint?.cursor?.path === 'string' ? ctx.checkpoint.cursor.path : null;

  const skipPaths = ctx.carry?.skipPaths instanceof Set ? ctx.carry.skipPaths : null;
  const incremental = Boolean(skipPaths && skipPaths.size > 0);
  const removedPaths = Array.isArray(ctx.carry?.removedPaths) ? ctx.carry.removedPaths : [];

  if (!resumePath) {
    if (!incremental) {
      try {
        await resetProjectWorkspaceSubtree(workspacePath, workspaceRoot);
      } catch (err) {
        const mapped = temporaryIoFailureOrNull(err);
        if (mapped) {
          throw mapped;
        }
        if (err && typeof err === 'object' && 'code' in err) {
          const unsafe = String(/** @type {{ code?: unknown }} */ (err).code);
          if (unsafe === 'WORKSPACE_PATH_UNSAFE') {
            throw createJobFailureError({
              failureClass: 'permanent',
              code: 'WORKSPACE_PATH_UNSAFE',
              message: 'Workspace reset refused an unsafe path.',
            });
          }
        }
        throw createJobFailureError({
          failureClass: 'temporary',
          code: 'WORKSPACE_IO_ERROR',
          message: 'Failed to reset the project workspace before materialization.',
        });
      }
      await softDeleteSectionsForVersion({
        orgId: ctx.scope.orgId,
        projectId: ctx.scope.projectId,
        sourceVersionId: ctx.scope.sourceVersionId,
      });
    } else {
      for (const removedPath of removedPaths) {
        try {
          await deleteWorkspaceRelativePath(workspacePath, removedPath);
        } catch (err) {
          const mapped = temporaryIoFailureOrNull(err);
          if (mapped) {
            throw mapped;
          }
          if (err && typeof err === 'object' && 'code' in err) {
            const unsafe = String(/** @type {{ code?: unknown }} */ (err).code);
            if (unsafe === 'WORKSPACE_PATH_UNSAFE') {
              throw createJobFailureError({
                failureClass: 'permanent',
                code: 'WORKSPACE_PATH_UNSAFE',
                message: 'A removed path failed workspace path-safety checks.',
              });
            }
          }
          throw createJobFailureError({
            failureClass: 'temporary',
            code: 'WORKSPACE_IO_ERROR',
            message: 'Failed to delete a removed path from the workspace.',
          });
        }
      }
    }
  }

  const allFiles = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    afterPath: resumePath,
  });

  const files = allFiles.filter(
    (file) => !file.fileState || file.fileState === SOURCE_FILE_STATE_STORED,
  );

  /** @type {object[]} */
  const warnings = [];
  let pathsWritten = 0;
  let documentationFiles = 0;
  let documentationSections = 0;
  let sinceBatch = 0;
  let lastPath = resumePath;

  for (const file of files) {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      if (lastPath) {
        await ctx.saveInProgressCursor({ path: lastPath }, 'materialize_docs');
        await ctx.saveProgress(true);
      }
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    if (skipPaths?.has(file.path)) {
      try {
        const diskPath = resolveSafeWorkspaceFilePath(workspacePath, file.path);
        try {
          await fs.access(diskPath);
        } catch {
          await materializeGridFsFileToDisk({
            workspacePath,
            relativePath: file.path,
            gridFsId: file.gridFsId,
          });
          pathsWritten += 1;
        }
      } catch (err) {
        const mapped = temporaryIoFailureOrNull(err);
        if (mapped) {
          if (lastPath) {
            await ctx.saveInProgressCursor({ path: lastPath }, 'materialize_docs');
            await ctx.saveProgress(true);
          }
          throw mapped;
        }
        if (err && typeof err === 'object' && 'code' in err) {
          const code = String(/** @type {{ code?: unknown }} */ (err).code);
          if (code === 'WORKSPACE_PATH_UNSAFE') {
            throw createJobFailureError({
              failureClass: 'permanent',
              code: 'WORKSPACE_PATH_UNSAFE',
              message: 'A source path failed workspace path-safety checks.',
            });
          }
        }
        warnings.push({ code: 'GRIDFS_READ_FAILED', path: file.path });
        ctx.counters.filesFailed += 1;
      }
      lastPath = file.path;
      sinceBatch += 1;
      sinceBatch = await maybeFlushCursor(ctx, lastPath, sinceBatch);
      continue;
    }

    try {
      await materializeGridFsFileToDisk({
        workspacePath,
        relativePath: file.path,
        gridFsId: file.gridFsId,
      });
    } catch (err) {
      const mapped = temporaryIoFailureOrNull(err);
      if (mapped) {
        if (lastPath) {
          await ctx.saveInProgressCursor({ path: lastPath }, 'materialize_docs');
          await ctx.saveProgress(true);
        }
        throw mapped;
      }
      if (err && typeof err === 'object' && 'code' in err) {
        const code = String(/** @type {{ code?: unknown }} */ (err).code);
        if (code === 'WORKSPACE_PATH_UNSAFE') {
          throw createJobFailureError({
            failureClass: 'permanent',
            code: 'WORKSPACE_PATH_UNSAFE',
            message: 'A source path failed workspace path-safety checks.',
          });
        }
      }
      warnings.push({ code: 'GRIDFS_READ_FAILED', path: file.path });
      ctx.counters.filesFailed += 1;
      ctx.counters.filesProcessed += 1;
      ctx.noteFileProcessed();
      lastPath = file.path;
      sinceBatch += 1;
      sinceBatch = await maybeFlushCursor(ctx, lastPath, sinceBatch);
      continue;
    }

    pathsWritten += 1;
    ctx.counters.filesProcessed += 1;
    ctx.counters.bytesProcessed += file.byteLength ?? 0;

    if (isDocumentPath(file.path) || file.kind === 'doc') {
      try {
        const diskPath = resolveSafeWorkspaceFilePath(workspacePath, file.path);
        const content = await fs.readFile(diskPath, 'utf8');
        const sections = parseDocumentSections({ path: file.path, content });
        await softDeleteSectionsForPath({
          orgId: ctx.scope.orgId,
          projectId: ctx.scope.projectId,
          sourceVersionId: ctx.scope.sourceVersionId,
          path: file.path,
        });
        const inserted = await insertDocumentSections({
          orgId: ctx.scope.orgId,
          projectId: ctx.scope.projectId,
          sourceVersionId: ctx.scope.sourceVersionId,
          path: file.path,
          sections,
        });
        documentationFiles += 1;
        documentationSections += inserted;
      } catch {
        warnings.push({ code: 'DOCUMENT_PARSE_FAILED', path: file.path });
        ctx.counters.filesFailed += 1;
      }
    }

    ctx.noteFileProcessed();
    lastPath = file.path;
    sinceBatch += 1;
    sinceBatch = await maybeFlushCursor(ctx, lastPath, sinceBatch);
  }

  if (incremental && ctx.carry?.baseSourceVersionId && skipPaths) {
    const copied = await copySectionsForPaths({
      orgId: ctx.scope.orgId,
      projectId: ctx.scope.projectId,
      fromSourceVersionId: ctx.carry.baseSourceVersionId,
      toSourceVersionId: ctx.scope.sourceVersionId,
      paths: [...skipPaths],
    });
    documentationSections += copied;
  }

  await ctx.emitEvent(buildWorkspaceMaterializedEvent({ pathsWritten }));
  await ctx.emitEvent(
    buildDocumentationIdentifiedEvent({
      documentationFiles,
      documentationSections,
      failedDocuments: warnings.filter((w) => w.code === 'DOCUMENT_PARSE_FAILED').length,
    }),
  );
  await ctx.saveProgress(true);

  return {
    outcome: warnings.length > 0 ? 'completed_with_warnings' : 'completed',
    cursor: null,
    warnings,
  };
}
