/**
 * S2 exclude_apply — replay Phase 23 exclusion decisions on reconciled files.
 */
import { createJobFailureError } from '../../../worker/retryPolicy.js';
import {
  assertKnownExclusionRulesetId,
  evaluateUploadEntry,
} from '../../sources/exclusions/index.js';
import { buildExclusionsAppliedEvent } from '../ingest.events.js';
import {
  SOURCE_FILE_STATE_STORED,
  listSourceFilesOrdered,
  updateSourceFileExclusion,
} from '../ingest.repository.js';

/**
 * Runs S2 exclude_apply. Exclusions never fail the job.
 * @param {object} ctx IngestStageContext.
 * @returns {Promise<{ outcome: 'completed', cursor: null }>}
 */
export async function runExcludeApplyStage(ctx) {
  const version = ctx.carry.sourceVersion;
  try {
    assertKnownExclusionRulesetId(version?.exclusionRulesetId);
  } catch {
    throw createJobFailureError({
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

  let excludedPaths = 0;

  for (const file of files) {
    if (ctx.signal?.aborted || (await ctx.isCancelRequested())) {
      throw createJobFailureError({
        failureClass: 'temporary',
        code: 'INGEST_ABORTED',
        message: 'Ingest was cancelled or the worker lost its lease.',
      });
    }

    // Only reconcile stored files; missing/corrupt stay failed from S1.
    if (file.fileState && file.fileState !== SOURCE_FILE_STATE_STORED) {
      continue;
    }

    const decision = evaluateUploadEntry({
      path: file.path,
      uncompressedSize: file.byteLength ?? 0,
    });

    let excludedFromGraph = false;
    let exclusionReason = null;

    if (decision.decision === 'skip') {
      // Should not normally appear in SourceFile (upload skipped them); record visibly.
      excludedFromGraph = true;
      exclusionReason = decision.reasonCode ?? 'unsupported_extension';
    } else if (decision.decision === 'accept_excluded_from_graph') {
      excludedFromGraph = true;
      exclusionReason = decision.reasonCode ?? 'file_too_large';
    }

    // Provisional unsupported_language hook — Phase 27 owns the authoritative list.
    // No-op today: evaluateUploadEntry does not emit unsupported_language.

    if (
      file.excludedFromGraph !== excludedFromGraph ||
      (file.exclusionReason ?? null) !== exclusionReason
    ) {
      await updateSourceFileExclusion({
        orgId: ctx.scope.orgId,
        sourceFileId: file._id,
        excludedFromGraph,
        exclusionReason,
      });
    }

    if (excludedFromGraph) {
      excludedPaths += 1;
      ctx.counters.filesExcluded += 1;
      if (exclusionReason) {
        ctx.counters.excludedByReason[exclusionReason] =
          (ctx.counters.excludedByReason[exclusionReason] ?? 0) + 1;
      }
    }

    ctx.noteFileProcessed();
    await ctx.saveProgress(false);
  }

  await ctx.emitEvent(
    buildExclusionsAppliedEvent({
      excludedPaths,
      filesProcessed: ctx.counters.filesProcessed,
      filesFailed: ctx.counters.filesFailed,
    }),
  );
  await ctx.saveProgress(true);

  return { outcome: 'completed', cursor: null };
}
