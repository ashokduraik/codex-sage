/**
 * Failure classification and exponential backoff for temporary failures.
 */
import { WORKER_MAX_ATTEMPTS, WORKER_RETRY_BACKOFF_BASE_MS, WORKER_RETRY_BACKOFF_MAX_MS } from './worker.constants.js';

/** @typedef {'temporary' | 'permanent' | 'user_action_required'} FailureClass */

/**
 * @typedef {{
 *   failureClass: FailureClass,
 *   code: string,
 *   message: string,
 * }} ClassifiedFailure
 */

/**
 * @typedef {{
 *   action: 'requeue' | 'fail',
 *   failureClass: FailureClass,
 *   code: string,
 *   message: string,
 *   delayMs: number,
 * }} FailureDecision
 */

/**
 * Builds a classified job failure error handlers throw into the loop.
 * @param {{ failureClass: FailureClass, code: string, message: string }} input Failure fields.
 * @returns {Error & ClassifiedFailure}
 */
export function createJobFailureError(input) {
  const error = /** @type {Error & ClassifiedFailure} */ (new Error(input.message));
  error.failureClass = input.failureClass;
  error.code = input.code;
  error.name = 'JobFailureError';
  return error;
}

/**
 * Extracts failure classification from a thrown value.
 * Unclassified errors are treated as temporary (a bug, not a policy).
 * @param {unknown} thrown Handler throw value.
 * @returns {ClassifiedFailure & { unclassified: boolean }}
 */
export function classifyThrownFailure(thrown) {
  if (
    thrown &&
    typeof thrown === 'object' &&
    'failureClass' in thrown &&
    typeof (/** @type {{ failureClass?: unknown }} */ (thrown).failureClass) === 'string' &&
    'code' in thrown &&
    typeof (/** @type {{ code?: unknown }} */ (thrown).code) === 'string'
  ) {
    const failureClass = /** @type {FailureClass} */ (/** @type {{ failureClass: string }} */ (thrown).failureClass);
    if (failureClass === 'temporary' || failureClass === 'permanent' || failureClass === 'user_action_required') {
      return {
        failureClass,
        code: /** @type {{ code: string }} */ (thrown).code,
        message: thrown instanceof Error ? thrown.message : String(/** @type {{ message?: unknown }} */ (thrown).message ?? 'Job failed'),
        unclassified: false,
      };
    }
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown ?? 'Job failed');
  return {
    failureClass: 'temporary',
    code: 'WORKER_UNCLASSIFIED_ERROR',
    message,
    unclassified: true,
  };
}

/**
 * Computes exponential backoff with jitter for the given attempt number (1-based).
 * @param {number} attempt Current attempt after claim (1-based).
 * @param {{
 *   baseMs?: number,
 *   maxMs?: number,
 *   random?: () => number,
 * }} [options] Optional overrides (tests inject random).
 * @returns {number} Delay in milliseconds (always positive).
 */
export function computeRetryBackoffMs(attempt, options = {}) {
  const baseMs = options.baseMs ?? WORKER_RETRY_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? WORKER_RETRY_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(baseMs * 2 ** (safeAttempt - 1), maxMs);
  const jitter = Math.floor(random() * Math.max(1, Math.floor(exponential * 0.2)));
  return Math.max(1, exponential + jitter);
}

/**
 * Decides whether to requeue or fail after a classified error.
 * @param {{
 *   failure: ClassifiedFailure,
 *   attempt: number,
 *   maxAttempts?: number,
 * }} input Decision inputs.
 * @returns {FailureDecision}
 */
export function decideFailureOutcome(input) {
  const maxAttempts = typeof input.maxAttempts === 'number' && input.maxAttempts >= 1 ? input.maxAttempts : WORKER_MAX_ATTEMPTS;
  const { failure, attempt } = input;

  if (failure.failureClass === 'permanent' || failure.failureClass === 'user_action_required') {
    return {
      action: 'fail',
      failureClass: failure.failureClass,
      code: failure.code,
      message: failure.message,
      delayMs: 0,
    };
  }

  if (attempt >= maxAttempts) {
    return {
      action: 'fail',
      failureClass: 'temporary',
      code: failure.code,
      message: failure.message,
      delayMs: 0,
    };
  }

  return {
    action: 'requeue',
    failureClass: 'temporary',
    code: failure.code,
    message: failure.message,
    delayMs: computeRetryBackoffMs(attempt),
  };
}
