/**
 * Public surface of the sources module (exclusions + upload persistence).
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

export {
  normalizeArchivePath,
  isUnsafeArchivePath,
  assertSafeArchivePath,
} from './exclusions/pathSafety.js';

export {
  GRIDFS_SOURCE_BUCKET,
  UPLOAD_HASH_ALGORITHM,
  MULTIPART_MAX_FILES,
  ARCHIVE_FIELD_NAME,
  SOURCE_ORIGIN_UPLOAD,
  VERSION_LIFECYCLE_VALUES,
  VERSION_LIFECYCLE_RECEIVED,
  SOURCE_FILE_KIND_VALUES,
  SOURCE_FILE_STATE_VALUES,
  SOURCE_FILE_STATE_STORED,
  SOURCE_FILE_STATE_MISSING,
  SOURCE_FILE_STATE_CORRUPT,
} from './sources.constants.js';

export { SourceVersion } from './sourceVersion.model.js';
export { SourceFile } from './sourceFile.model.js';
export {
  getSourceFilesBucket,
  buildSourceGridFsFilename,
  markGridFsFilesOrphaned,
  findSourceGridFsFileById,
  listSourceGridFsFilesForVersion,
  openSourceGridFsDownloadStream,
  clearSourceFilesBucket,
} from './gridfs.js';
export {
  insertSourceVersion,
  insertSourceFiles,
  setSourceVersionJobId,
  countSourceVersions,
  listSourceFilesForVersion,
  findSourceVersionById,
  findActiveSourceVersionForProject,
  listSourceFilePathHashesPage,
} from './sources.repository.js';
export { kindForSourcePath } from './sourceFileKind.js';
export { consumeSourceArchivePreHandler } from './consumeSourceArchive.js';
export { persistSourceUpload, storeAcceptedZipEntries } from './upload.service.js';
export { sourceUploadRoutes } from './upload.routes.js';
export { sourceRoutes } from './sources.routes.js';
export { enqueueSourceReingest } from './sources.service.js';
export {
  SOURCE_DIFF_BATCH_SIZE,
  classifySourceDiff,
  loadPathHashesForVersion,
  computeSourceDiff,
  carryFromSourceDiff,
} from './sourceDiff.js';
export { SourceChangeSummary, SOURCE_DIFF_STATUS_VALUES } from './sourceChangeSummary.model.js';
export {
  findChangeSummaryForVersion,
  upsertChangeSummary,
} from './sourceChangeSummary.repository.js';

import { SourceFile } from './sourceFile.model.js';
import { SourceVersion } from './sourceVersion.model.js';
import { SourceChangeSummary } from './sourceChangeSummary.model.js';

/** Models whose indexes are synced on development API startup / test harness. */
export const SOURCE_MODELS = Object.freeze([
  SourceVersion,
  SourceFile,
  SourceChangeSummary,
]);
