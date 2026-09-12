/**
 * Public surface of the sources module (Phase 23 exclusions; persistence in Phase 24).
 */
export {
  EXCLUSION_RULESET_ID,
  GRAPH_FILE_MAX_BYTES,
  UPLOAD_MAX_ARCHIVE_BYTES,
  UPLOAD_MAX_ENTRY_COUNT,
  evaluateUploadEntry,
  inspectZip,
  summarizeInspection,
  assertKnownExclusionRulesetId,
} from './exclusions/index.js';
