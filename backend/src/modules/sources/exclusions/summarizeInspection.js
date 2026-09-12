/**
 * Summarizes per-entry decisions into the upload inspection result shape.
 */
import { ApiError } from '../../../platform/errors.js';
import { EXCLUSION_RULESET_ID } from './exclusions.constants.js';
import { evaluateUploadEntry } from './pathDecision.js';

/**
 * Applies exclusion rules to listed zip entries and returns the Phase 23 result object.
 * Throws when nothing remains after exclusions (fail closed for Phase 24).
 * @param {Array<{ path: string, uncompressedSize: number }>} entries
 * @returns {{
 *   rulesetId: string,
 *   accepted: Array<{ path: string, size: number, excludedFromGraph: boolean, exclusionReason?: string }>,
 *   skipped: Array<{ path: string, reasonCode: string }>,
 *   emptyAfterExclude: false
 * }}
 * @throws {ApiError} SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS when no accepted paths remain.
 */
export function summarizeInspection(entries) {
  /** @type {Array<{ path: string, size: number, excludedFromGraph: boolean, exclusionReason?: string }>} */
  const accepted = [];
  /** @type {Array<{ path: string, reasonCode: string }>} */
  const skipped = [];

  for (const entry of entries) {
    const { decision, reasonCode } = evaluateUploadEntry(entry);
    if (decision === 'skip') {
      skipped.push({ path: entry.path, reasonCode: reasonCode ?? 'skipped' });
      continue;
    }
    if (decision === 'accept_excluded_from_graph') {
      accepted.push({
        path: entry.path,
        size: entry.uncompressedSize,
        excludedFromGraph: true,
        exclusionReason: reasonCode ?? 'file_too_large',
      });
      continue;
    }
    accepted.push({
      path: entry.path,
      size: entry.uncompressedSize,
      excludedFromGraph: false,
    });
  }

  if (accepted.length === 0) {
    throw ApiError.fromCode('SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS');
  }

  return {
    rulesetId: EXCLUSION_RULESET_ID,
    accepted,
    skipped,
    emptyAfterExclude: false,
  };
}
