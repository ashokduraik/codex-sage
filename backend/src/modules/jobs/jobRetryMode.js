/**
 * Resolves user-facing retry mode from stored failure state (never from client input).
 */

/** Stages whose bytes are wrong — user must upload again (solution §4.6 S0). */
const USER_ACTION_UPLOAD_STAGES = new Set(['validate_upload', 'store_files']);

/** Stages that require a full pipeline rebuild when they fail permanently. */
const FULL_REBUILD_STAGES = new Set(['codegraph_update', 'knowledge_publish']);

/**
 * @typedef {{
 *   mode: 'resume' | 'full' | 'not_retryable',
 *   fromStage: string | null,
 *   reason: string | null,
 * }} JobRetryResolution
 */

/**
 * Resolves retry mode for a failed or cancelled job.
 * @param {{
 *   jobStatus: string,
 *   failureClass?: string | null,
 *   currentStage?: string | null,
 *   stageCheckpoint?: { lastCompletedStage?: string | null } | null,
 * }} job Job document fields.
 * @returns {JobRetryResolution}
 */
export function resolveJobRetryMode(job) {
  const failedStage = job.currentStage ?? null;
  const lastCompleted = job.stageCheckpoint?.lastCompletedStage ?? null;
  const failureClass = job.failureClass ?? null;

  if (
    failureClass === 'user_action_required' &&
    failedStage &&
    USER_ACTION_UPLOAD_STAGES.has(failedStage)
  ) {
    return {
      mode: 'not_retryable',
      fromStage: null,
      reason:
        'This upload cannot be retried. Remove excluded or invalid content and upload the project again.',
    };
  }

  if (failedStage && FULL_REBUILD_STAGES.has(failedStage)) {
    return {
      mode: 'full',
      fromStage: 'validate_upload',
      reason:
        'The project structure update failed. Retry re-runs processing from the start against the stored source.',
    };
  }

  if (failureClass === 'permanent' && (!lastCompleted || FULL_REBUILD_STAGES.has(failedStage ?? ''))) {
    return {
      mode: 'full',
      fromStage: 'validate_upload',
      reason:
        'This failure cannot be partially redone. Retry re-runs the full processing pipeline.',
    };
  }

  if (lastCompleted) {
    return {
      mode: 'resume',
      fromStage: failedStage ?? lastCompleted,
      reason: null,
    };
  }

  return {
    mode: 'full',
    fromStage: 'validate_upload',
    reason: 'No checkpoint is available. Retry re-runs processing from the start.',
  };
}

/**
 * Read-only retry availability for the job detail payload.
 * @param {object} job Job document fields.
 * @param {number} maxUserRetries Ceiling on user-initiated retries.
 * @returns {{ available: boolean, mode: 'resume' | 'full' | null, reason: string | null }}
 */
export function describeRetryAvailability(job, maxUserRetries) {
  const status = job.jobStatus;
  if (status !== 'failed' && status !== 'cancelled') {
    return { available: false, mode: null, reason: null };
  }
  if ((job.retryCount ?? 0) >= maxUserRetries) {
    return {
      available: false,
      mode: null,
      reason: 'This job has reached the maximum number of user-initiated retries.',
    };
  }
  const resolved = resolveJobRetryMode(job);
  if (resolved.mode === 'not_retryable') {
    return { available: false, mode: null, reason: resolved.reason };
  }
  return {
    available: true,
    mode: resolved.mode,
    reason: resolved.reason,
  };
}
