/**
 * Same-job S4 recovery — rematerialize this source version and full indexAll.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createJobFailureError } from '../../worker/retryPolicy.js';
import {
  CODEGRAPH_DIR_NAME,
  resolveCodegraphDir,
} from '../codegraph/codegraph.paths.js';
import { runMaterializeDocsStage } from '../ingest/stages/s3MaterializeDocs.js';
import { runCodegraphUpdateStage } from '../ingest/stages/s4CodegraphUpdate.js';

/** Bounded rematerialize + indexAll attempts before knowledge fails permanently. */
export const KNOWLEDGE_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Deletes the on-disk `.codegraph` directory so the next S4 takes indexAll.
 * @param {string} workspacePath Absolute project workspace.
 * @returns {Promise<void>}
 */
export async function wipeCodegraphIndex(workspacePath) {
  const graphDir = resolveCodegraphDir(workspacePath);
  await fs.rm(graphDir, { recursive: true, force: true });
  // Ensure parent still exists for the next indexAll.
  await fs.mkdir(path.dirname(graphDir), { recursive: true });
}

/**
 * True when a thrown value is a temporary CodeGraph failure eligible for recovery.
 * @param {unknown} err Thrown value.
 * @returns {boolean}
 */
export function isRecoverableCodegraphFailure(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const failureClass = /** @type {{ failureClass?: unknown }} */ (err).failureClass;
  const code = String(/** @type {{ code?: unknown }} */ (err).code ?? '');
  if (failureClass !== 'temporary') {
    return false;
  }
  return (
    code.startsWith('CODEGRAPH_') ||
    code === 'INGEST_STAGE_TIMEOUT' ||
    code === 'WORKSPACE_IO_ERROR'
  );
}

/**
 * Runs S4 with same-job recovery: rematerialize this version, wipe index, retry indexAll.
 * @param {object} ctx IngestStageContext.
 * @param {{
 *   runS3?: typeof runMaterializeDocsStage,
 *   runS4?: typeof runCodegraphUpdateStage,
 *   wipeIndex?: typeof wipeCodegraphIndex,
 *   maxAttempts?: number,
 * }} [deps] Test seams.
 * @returns {Promise<object>} S4 stage result.
 */
export async function runCodegraphUpdateWithRecovery(ctx, deps = {}) {
  const runS3 = deps.runS3 ?? runMaterializeDocsStage;
  const runS4 = deps.runS4 ?? runCodegraphUpdateStage;
  const wipeIndex = deps.wipeIndex ?? wipeCodegraphIndex;
  const maxAttempts = deps.maxAttempts ?? KNOWLEDGE_RECOVERY_MAX_ATTEMPTS;

  try {
    return await runS4(ctx);
  } catch (err) {
    if (!isRecoverableCodegraphFailure(err)) {
      throw err;
    }

    const priorAttempts = Number(ctx.checkpoint?.cursor?.recoveryAttempts ?? 0);
    if (priorAttempts >= maxAttempts) {
      throw createJobFailureError({
        failureClass: 'permanent',
        code: 'CODEGRAPH_RECOVERY_EXHAUSTED',
        message: 'Code index recovery retries were exhausted.',
      });
    }

    const nextAttempts = priorAttempts + 1;
    const priorCursor =
      ctx.checkpoint?.cursor && typeof ctx.checkpoint.cursor === 'object'
        ? { ...ctx.checkpoint.cursor }
        : {};
    priorCursor.recoveryAttempts = nextAttempts;

    const lastCompleted = ctx.checkpoint?.lastCompletedStage ?? null;
    if (lastCompleted) {
      await ctx.saveCheckpoint({
        lastCompletedStage: lastCompleted,
        cursor: priorCursor,
        currentStage: 'codegraph_update',
      });
      ctx.checkpoint = {
        lastCompletedStage: lastCompleted,
        cursor: priorCursor,
      };
    }

    ctx.logger?.warn?.(
      { recoveryAttempts: nextAttempts, maxAttempts },
      'codegraph recovery rematerialize starting',
    );

    await runS3(ctx);

    const workspacePath =
      typeof ctx.carry?.workspacePath === 'string' ? ctx.carry.workspacePath : null;
    if (workspacePath) {
      await wipeIndex(workspacePath);
    }

    // Clear changedPaths so S4 prefers full index after wipe.
    if (ctx.carry) {
      delete ctx.carry.changedPaths;
    }

    return runS4(ctx);
  }
}

export { CODEGRAPH_DIR_NAME };
