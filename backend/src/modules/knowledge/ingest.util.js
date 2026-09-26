/**
 * knowledge/ingest.util.js — merged resource file.
 */
import { loadConfig } from '../../platform/config.js';
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { findProjectById } from '../masters/index.js';
import { codegraphIndexExists, createCodegraphAdapter } from './codegraph.js';
import {
  copySectionsForPaths,
  insertDocumentSections,
  isDocumentPath,
  parseDocumentSections,
  softDeleteSectionsForPath,
  softDeleteSectionsForVersion,
} from './documents.js';
import {
  buildDocumentationIdentifiedEvent,
  buildWorkspaceMaterializedEvent,
  buildCodeRelationshipsAnalyzedEvent,
  buildProjectStructureAnalyzedEvent,
} from './ingest.helper.js';
import { findChangeSummaryForVersion, upsertChangeSummary } from './changeSummary.js';
import { listSourceFilesOrdered } from './ingest.js';
import { findKnowledgeVersionById } from './knowledge.js';
import {
  SOURCE_FILE_STATE_STORED,
  carryFromSourceDiff,
  computeSourceDiff,
  deleteWorkspaceRelativePath,
  materializeGridFsFileToDisk,
  resetProjectWorkspaceSubtree,
  resolveProjectWorkspacePath,
  resolveSafeWorkspaceFilePath,
} from './sources.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// --- from ingest/applySourceDiff.js ---
/**
 * Post-S0 source diff hook — incremental carry for new-upload ingest only.
 */
/**
 * Applies a persisted summary onto ingest carry.
 * @param {object} ctx IngestStageContext.
 * @param {object} summary Stored summary.
 */
function applySummaryToCarry(ctx, summary) {
  const carry = carryFromSourceDiff({
    added: summary.paths?.added ?? [],
    removed: summary.paths?.removed ?? [],
    changed: summary.paths?.changed ?? [],
    unchanged: summary.paths?.unchanged ?? [],
    baseSourceVersionId: summary.previousSourceVersionId
      ? String(summary.previousSourceVersionId)
      : null,
  });
  ctx.carry.skipPaths = carry.skipPaths;
  ctx.carry.changedPaths = carry.changedPaths;
  ctx.carry.removedPaths = carry.removedPaths;
  ctx.carry.baseSourceVersionId = carry.baseSourceVersionId;
}

/**
 * Restores skip/changed/removed carry from a persisted summary when resuming.
 * @param {object} ctx IngestStageContext.
 * @param {object} job Claimed job document.
 * @returns {Promise<void>}
 */
export async function hydrateSourceDiffCarry(ctx, job) {
  if (job.jobType !== 'ingest') {
    return;
  }
  const summary = await findChangeSummaryForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  if (summary?.diffStatus === 'computed') {
    applySummaryToCarry(ctx, summary);
  }
}

/**
 * Computes and persists a path+sha256 diff after S0 for a new-upload ingest job.
 * @param {object} ctx IngestStageContext.
 * @param {object} job Claimed job document.
 * @returns {Promise<void>}
 */
export async function applySourceDiffAfterValidate(ctx, job) {
  if (job.jobType !== 'ingest') {
    return;
  }

  const existing = await findChangeSummaryForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  if (existing?.diffStatus === 'computed') {
    applySummaryToCarry(ctx, existing);
    return;
  }

  const project = await findProjectById(ctx.scope.orgId, ctx.scope.projectId);
  const knowledgeVersionId = project?.currentKnowledgeVersionId
    ? String(project.currentKnowledgeVersionId)
    : null;
  const published =
    knowledgeVersionId
      ? await findKnowledgeVersionById({
          orgId: ctx.scope.orgId,
          projectId: ctx.scope.projectId,
          knowledgeVersionId,
        })
      : null;
  const publishedSourceVersionId = published?.sourceVersionId
    ? String(published.sourceVersionId)
    : null;

  if (
    publishedSourceVersionId &&
    publishedSourceVersionId === String(ctx.scope.sourceVersionId)
  ) {
    return;
  }

  const diff = await computeSourceDiff({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    incomingSourceVersionId: ctx.scope.sourceVersionId,
    publishedSourceVersionId,
  });

  await upsertChangeSummary({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
    previousSourceVersionId: diff.baseSourceVersionId,
    knowledgeVersionId,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged,
    counts: diff.counts,
  });

  const carry = carryFromSourceDiff(diff);
  ctx.carry.skipPaths = carry.skipPaths;
  ctx.carry.changedPaths = carry.changedPaths;
  ctx.carry.removedPaths = carry.removedPaths;
  ctx.carry.baseSourceVersionId = carry.baseSourceVersionId;
}

// --- from ingest/stages/s3MaterializeDocs.js ---
/**
 * S3 materialize_docs — recreate workspace tree and index document sections.
 */
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

// --- from ingest/stages/s4CodegraphUpdate.js ---
/**
 * S4 codegraph_update — index or sync the materialized tree via the CodeGraph adapter.
 */
/** @type {ReturnType<typeof createCodegraphAdapter> | null} */
let defaultAdapter = null;

/**
 * Runs the S4 CodeGraph index/sync stage.
 * @param {object} ctx IngestStageContext.
 * @param {{ adapter?: ReturnType<typeof createCodegraphAdapter> }} [deps] Test seams.
 * @returns {Promise<{
 *   outcome: 'completed' | 'completed_with_warnings',
 *   cursor: { graphIdentity: object },
 *   warnings: object[],
 * }>}
 */
export async function runCodegraphUpdateStage(ctx, deps = {}) {
  if (!deps.adapter && !defaultAdapter) {
    defaultAdapter = createCodegraphAdapter();
  }
  const adapter = deps.adapter ?? defaultAdapter;

  if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
    throw createJobFailureError({
      failureClass: 'temporary',
      code: 'INGEST_ABORTED',
      message: 'Ingest was cancelled or the worker lost its lease.',
    });
  }

  let workspaceRoot;
  try {
    workspaceRoot = resolveWorkspaceRoot(ctx);
  } catch {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'WORKSPACE_ROOT_INVALID',
      message: 'Workspace root is not configured for CodeGraph indexing.',
    });
  }

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

  const allFiles = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });

  const storedFiles = allFiles.filter(
    (file) => !file.fileState || file.fileState === SOURCE_FILE_STATE_STORED,
  );
  const excludedPaths = storedFiles
    .filter((file) => file.excludedFromGraph === true)
    .map((file) => file.path);
  const filesForGraph = storedFiles.filter((file) => file.excludedFromGraph !== true);
  const includePaths = filesForGraph.map((file) => file.path);

  adapter.configureTelemetryOff();

  const release = await adapter.acquireWriter({
    orgId: String(ctx.scope.orgId),
    projectId: String(ctx.scope.projectId),
  });

  /** @type {object | null} */
  let liveGraph = null;
  /** @type {object[]} */
  const warnings = [];

  try {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    const indexExists = await codegraphIndexExists(workspacePath);
    const changedPaths =
      Array.isArray(ctx.carry?.changedPaths)
        ? ctx.carry.changedPaths
        : ctx.carry?.changedPaths instanceof Set
          ? [...ctx.carry.changedPaths]
          : undefined;
    const removedPaths = Array.isArray(ctx.carry?.removedPaths)
      ? ctx.carry.removedPaths
      : ctx.carry?.removedPaths instanceof Set
        ? [...ctx.carry.removedPaths]
        : [];
    const syncChangedPaths = removedPaths.length > 0 ? undefined : changedPaths;

    let updateResult;
    try {
      if (!indexExists) {
        updateResult = await adapter.indexAll(workspacePath, {
          excludedPaths,
          signal: ctx.signal,
        });
      } else {
        updateResult = await adapter.sync(workspacePath, {
          excludedPaths,
          changedPaths: syncChangedPaths,
          signal: ctx.signal,
        });
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'failureClass' in err && 'code' in err) {
        throw createJobFailureError({
          failureClass: /** @type {'temporary' | 'permanent' | 'user_action_required'} */ (
            err.failureClass
          ),
          code: String(err.code),
          message: err instanceof Error ? err.message : 'Code index update failed.',
        });
      }
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'CODEGRAPH_LIBRARY_ERROR',
        message: 'Code index update failed.',
      });
    }

    liveGraph = updateResult.graph ?? null;
    adapter.disableFilesystemWatch(updateResult.graph ?? { unwatch() {}, isWatching: () => false });

    if (updateResult.filesErrored > 0) {
      warnings.push({
        code: 'CODEGRAPH_FILE_ERRORS',
        filesErrored: updateResult.filesErrored,
      });
    }

    let validation;
    try {
      validation = await adapter.validate(workspacePath, {
        graph: liveGraph ?? undefined,
        sourceVersionId: String(ctx.scope.sourceVersionId),
        mode: updateResult.mode,
        indexedFileCount: updateResult.indexedFileCount,
        skippedFileCount: updateResult.skippedFileCount + excludedPaths.length,
        expectedIndexedFileCount: includePaths.length,
        expectedExcludedCount: excludedPaths.length,
        graphPath: updateResult.graphPath,
        graphHash: updateResult.graphHash,
      });
    } catch {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'CODEGRAPH_VALIDATION_FAILED',
        message: 'Code index validation failed.',
      });
    }

    if (validation.hardFail || !validation.ok) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'CODEGRAPH_VALIDATION_FAILED',
        message: 'Code index validation failed.',
      });
    }

    const graphIdentity = validation.identity;
    ctx.carry.graphIdentity = graphIdentity;

    await ctx.emitEvent(
      buildProjectStructureAnalyzedEvent({
        indexedFiles: graphIdentity.indexedFileCount,
        skippedFiles: graphIdentity.skippedFileCount,
      }),
    );
    await ctx.emitEvent(
      buildCodeRelationshipsAnalyzedEvent({
        indexedFiles: graphIdentity.indexedFileCount,
      }),
    );
    await ctx.saveProgress(true);

    return {
      outcome: warnings.length > 0 ? 'completed_with_warnings' : 'completed',
      cursor: { graphIdentity },
      warnings,
    };
  } finally {
    try {
      liveGraph?.close?.();
    } catch {
      // ignore close errors on stage exit
    }
    adapter.releaseWriter(release);
  }
}
