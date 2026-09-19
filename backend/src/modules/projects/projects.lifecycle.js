/**
 * Project lifecycle state machine — pure validation only (no I/O).
 */
import { ApiError } from '../../platform/errors.js';
import {
  KNOWLEDGE_HEALTH_VALUES,
  LIFECYCLE_STATUS_VALUES,
} from './projects.model.js';

/** Allowed next states keyed by current lifecycle status. */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  creating: Object.freeze(['awaiting_source', 'connecting_repository', 'failed']),
  awaiting_source: Object.freeze([
    'source_received',
    'connecting_repository',
    'failed',
    'archived',
  ]),
  connecting_repository: Object.freeze([
    'source_received',
    'awaiting_source',
    'failed',
    'archived',
  ]),
  source_received: Object.freeze(['processing', 'failed', 'archived']),
  processing: Object.freeze([
    'knowledge_ready',
    'partially_available',
    'failed',
    'archived',
  ]),
  knowledge_ready: Object.freeze(['updating', 'failed', 'archived']),
  updating: Object.freeze([
    'knowledge_ready',
    'partially_available',
    'failed',
    'archived',
  ]),
  partially_available: Object.freeze([
    'updating',
    'knowledge_ready',
    'failed',
    'archived',
  ]),
  failed: Object.freeze([
    'awaiting_source',
    'connecting_repository',
    'processing',
    'updating',
    'archived',
  ]),
  archived: Object.freeze([]),
});

/** States that require worker source + knowledgeVersionId. */
export const WORKER_ONLY_LIFECYCLE_STATUSES = Object.freeze([
  'knowledge_ready',
  'partially_available',
]);

/** Lifecycle states that cannot have knowledgeHealth ready. */
export const PRE_KNOWLEDGE_LIFECYCLE_STATUSES = Object.freeze([
  'creating',
  'awaiting_source',
  'connecting_repository',
  'source_received',
]);

/**
 * Returns whether `status` is a known lifecycle code.
 * @param {string} status Candidate.
 * @returns {boolean}
 */
export function isKnownLifecycleStatus(status) {
  return LIFECYCLE_STATUS_VALUES.includes(status);
}

/**
 * Returns whether `health` is a known knowledgeHealth code.
 * @param {string} health Candidate.
 * @returns {boolean}
 */
export function isKnownKnowledgeHealth(health) {
  return KNOWLEDGE_HEALTH_VALUES.includes(health);
}

/**
 * Maps create sourceType to the first post-creating lifecycle status.
 * @param {'upload' | 'repository'} sourceType Create path.
 * @returns {'awaiting_source' | 'connecting_repository'}
 */
export function initialLifecycleAfterCreate(sourceType) {
  if (sourceType === 'repository') {
    return 'connecting_repository';
  }
  return 'awaiting_source';
}

/**
 * Throws when a lifecycle transition is not allowed.
 * @param {{
 *   from: string,
 *   to: string,
 *   source: 'api' | 'worker',
 *   knowledgeVersionId?: string | null,
 * }} input Transition request.
 * @throws {ApiError} INVALID_STATE_TRANSITION
 */
export function assertLifecycleTransitionAllowed(input) {
  const { from, to, source, knowledgeVersionId } = input;
  const allowed = LIFECYCLE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from, to },
    });
  }

  if (WORKER_ONLY_LIFECYCLE_STATUSES.includes(to)) {
    if (source !== 'worker') {
      throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
        details: { from, to, reason: 'worker_source_required' },
      });
    }
    if (
      knowledgeVersionId === undefined ||
      knowledgeVersionId === null ||
      knowledgeVersionId === ''
    ) {
      throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
        details: { from, to, reason: 'knowledge_version_required' },
      });
    }
  }
}

/**
 * Throws when knowledgeHealth is incompatible with lifecycle.
 * @param {{ lifecycleStatus: string, knowledgeHealth: string }} input Pair to check.
 * @throws {ApiError} INVALID_STATE_TRANSITION
 */
export function assertKnowledgeHealthAllowed(input) {
  const { lifecycleStatus, knowledgeHealth } = input;
  const blockedBeforeProcessing =
    knowledgeHealth === 'ready' || knowledgeHealth === 'partially_available';
  if (
    blockedBeforeProcessing &&
    PRE_KNOWLEDGE_LIFECYCLE_STATUSES.includes(lifecycleStatus)
  ) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: {
        lifecycleStatus,
        knowledgeHealth,
        reason: 'knowledge_ready_before_processing',
      },
    });
  }
}
