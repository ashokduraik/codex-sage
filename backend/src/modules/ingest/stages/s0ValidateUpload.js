/**
 * S0 validate_upload — re-validate SourceVersion metadata and path safety.
 */
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import {
  assertKnownExclusionRulesetId,
} from '../../sources/exclusions/index.js';
import {
  isUnsafeArchivePath,
  normalizeArchivePath,
} from '../../sources/exclusions/pathSafety.js';
import {
  buildSourceReceivedEvent,
  buildSourceValidatedEvent,
} from '../ingest.events.js';
import {
  countSourceFilesForVersion,
  listSourceFilesOrdered,
  markSourceVersionFailed,
} from '../ingest.repository.js';

/**
 * Fails S0, marks the version failed, and throws a classified error.
 * @param {object} ctx IngestStageContext.
 * @param {{ code: string, failureClass: string, message: string }} failure Failure.
 * @returns {Promise<never>}
 */
async function failValidateUpload(ctx, failure) {
  if (ctx.scope.sourceVersionId) {
    await markSourceVersionFailed({
      orgId: ctx.scope.orgId,
      sourceVersionId: ctx.scope.sourceVersionId,
    });
  }
  throw createJobFailureError(failure);
}

/**
 * Runs S0 validate_upload.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{ outcome: 'completed', cursor: null }>}
 */
export async function runValidateUploadStage(ctx) {
  await ctx.emitEvent(buildSourceReceivedEvent());

  const version = ctx.carry.sourceVersion;
  if (!version) {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_SOURCE_VERSION_NOT_FOUND',
      message: 'The source version for this job was not found.',
    });
  }

  if (String(version.orgId) !== ctx.scope.orgId || String(version.projectId) !== ctx.scope.projectId) {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_TENANT_MISMATCH',
      message: 'The source version does not belong to this job organization or project.',
    });
  }

  if (version.status && version.status !== 'A') {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'INGEST_SOURCE_VERSION_INACTIVE',
      message: 'The source version is no longer active.',
    });
  }

  if (version.versionLifecycle !== 'received') {
    await failValidateUpload(ctx, {
      failureClass: 'user_action_required',
      code: 'INGEST_VERSION_NOT_PENDING',
      message: 'This source version is not awaiting ingest. Upload a new archive to continue.',
    });
  }

  try {
    assertKnownExclusionRulesetId(version.exclusionRulesetId);
  } catch {
    await failValidateUpload(ctx, {
      failureClass: 'permanent',
      code: 'SOURCE_UNKNOWN_EXCLUSION_RULESET',
      message: 'The exclusion ruleset recorded on this upload is no longer supported.',
    });
  }

  const files = await listSourceFilesOrdered({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });

  if (files.length === 0) {
    await failValidateUpload(ctx, {
      failureClass: 'user_action_required',
      code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      message: 'No usable files remain after exclusions. Upload a cleaner archive.',
    });
  }

  for (const file of files) {
    if (ctx.signal?.aborted) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }
    const normalized = normalizeArchivePath(file.path);
    if (normalized !== file.path || isUnsafeArchivePath(normalized)) {
      await failValidateUpload(ctx, {
        failureClass: 'user_action_required',
        code: 'SOURCE_PATH_UNSAFE',
        message: 'A stored path is unsafe. Upload a cleaner archive.',
      });
    }
  }

  const filesTotal = await countSourceFilesForVersion({
    orgId: ctx.scope.orgId,
    projectId: ctx.scope.projectId,
    sourceVersionId: ctx.scope.sourceVersionId,
  });
  ctx.counters.filesTotal = filesTotal;

  await ctx.emitEvent(buildSourceValidatedEvent(filesTotal));
  await ctx.saveProgress(true);

  return { outcome: 'completed', cursor: null };
}
