/**
 * S4 codegraph_update — index or sync the materialized tree via the CodeGraph adapter.
 */
import path from 'node:path';
import { loadConfig } from '../../../platform/config.js';
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import {
  codegraphIndexExists,
  createCodegraphAdapter,
} from '../../codegraph/index.js';
import { resolveProjectWorkspacePath } from '../../sources/index.js';
import {
  buildCodeRelationshipsAnalyzedEvent,
  buildProjectStructureAnalyzedEvent,
} from '../ingest.events.js';
import {
  SOURCE_FILE_STATE_STORED,
  listSourceFilesOrdered,
} from '../ingest.repository.js';

/** @type {ReturnType<typeof createCodegraphAdapter> | null} */
let defaultAdapter = null;

/**
 * Returns the process-wide adapter (lazy).
 * @returns {ReturnType<typeof createCodegraphAdapter>}
 */
function getDefaultAdapter() {
  if (!defaultAdapter) {
    defaultAdapter = createCodegraphAdapter();
  }
  return defaultAdapter;
}

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
  const adapter = deps.adapter ?? getDefaultAdapter();

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
