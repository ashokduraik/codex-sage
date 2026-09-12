/**
 * Allowed jobStatus transitions and a guard that rejects invalid pairs.
 */
import { ApiError } from '../../platform/errors.js';

/**
 * Allowed next statuses for each current jobStatus.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ALLOWED_JOB_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'cancelled']),
  running: Object.freeze([
    'completed',
    'completed_with_warnings',
    'failed',
    'cancelled',
    'pending',
  ]),
  failed: Object.freeze(['retrying']),
  retrying: Object.freeze(['pending', 'running', 'cancelled']),
  cancelled: Object.freeze(['retrying']),
  completed: Object.freeze([]),
  completed_with_warnings: Object.freeze([]),
});

/**
 * Returns whether `from` → `to` is an allowed jobStatus transition.
 * @param {string} from Current status.
 * @param {string} to Desired status.
 * @returns {boolean}
 */
export function isAllowedJobTransition(from, to) {
  const allowed = ALLOWED_JOB_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Asserts that a jobStatus transition is allowed.
 * @param {string} from Current status.
 * @param {string} to Desired status.
 * @throws {ApiError} INVALID_JOB_TRANSITION when the pair is not allowed.
 */
export function assertJobTransition(from, to) {
  if (isAllowedJobTransition(from, to)) {
    return;
  }
  throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
    details: { currentStatus: from, attemptedStatus: to },
  });
}
