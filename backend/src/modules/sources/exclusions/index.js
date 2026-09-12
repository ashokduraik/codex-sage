/**
 * Public surface of the upload exclusion / zip validation engine (Phase 23).
 */
import { ApiError } from '../../../platform/errors.js';
import {
  EXCLUSION_RULESET_ID,
  GRAPH_FILE_MAX_BYTES,
  UPLOAD_MAX_ARCHIVE_BYTES,
  UPLOAD_MAX_ENTRY_COUNT,
} from './exclusions.constants.js';
import { evaluateUploadEntry } from './pathDecision.js';
import { summarizeInspection } from './summarizeInspection.js';
import { inspectZip } from './zipInspect.js';

export {
  EXCLUSION_RULESET_ID,
  GRAPH_FILE_MAX_BYTES,
  UPLOAD_MAX_ARCHIVE_BYTES,
  UPLOAD_MAX_ENTRY_COUNT,
  evaluateUploadEntry,
  inspectZip,
  summarizeInspection,
};

/**
 * Ensures a recorded ruleset id is known to this process (Phase 25 S2 replay).
 * Unknown ids fail permanent rather than silently applying newer rules.
 * @param {string} rulesetId Value persisted on SourceVersion.
 * @returns {void}
 * @throws {ApiError} SOURCE_UNKNOWN_EXCLUSION_RULESET
 */
export function assertKnownExclusionRulesetId(rulesetId) {
  if (rulesetId !== EXCLUSION_RULESET_ID) {
    throw ApiError.fromCode('SOURCE_UNKNOWN_EXCLUSION_RULESET');
  }
}
