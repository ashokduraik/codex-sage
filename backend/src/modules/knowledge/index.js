/**
 * Public surface of the knowledge module (source, ingest, browse, search).
 */
export { UPLOAD_MAX_ARCHIVE_BYTES, consumeSourceArchivePreHandler, sourceUploadRoutes } from './uploads.js';
export { MULTIPART_MAX_FILES, sourceRoutes } from './sources.js';
export { changeSummaryRoutes } from './changeSummary.js';
export { sourcePreviewRoutes } from './sourcePreview.js';
export { repositoryRoutes } from './repositories.js';
export { repoSyncHandlerRegistration, enqueueDueRepositorySyncs, REPO_SYNC_SCHEDULER_TICK_MS } from './repoSync.js';
export { ingestHandlerRegistration, reingestHandlerRegistration } from './ingest.js';
export {
  countExcludedFromGraphFiles,
  findActiveKnowledgeVersionForSource,
  findKnowledgeVersionById,
  insertKnowledgeVersion,
  sanitizeGraphIdentityForPublish,
  resolvePublishedHealth,
  publishKnowledgeVersion,
  assertKnowledgeReadable,
  knowledgeBrowseRoutes,
  loadKnowledgeBrowse,
  clampBrowseLimit,
  KNOWLEDGE_SUMMARY_MAX_CHARS,
  mapBrowseFacets,
  emptyBrowseEnvelope,
  mapHealthDimensions,
  isRecoverableCodegraphFailure,
  runCodegraphUpdateWithRecovery,
} from './knowledge.js';
export { searchRoutes } from './search.js';

import { DocumentSection } from '../../models/documentSection.model.js';
import { KnowledgeVersion } from '../../models/knowledgeVersion.model.js';
import { RepositoryConnection } from '../../models/repositoryConnection.model.js';
import { SourceChangeSummary } from '../../models/sourceChangeSummary.model.js';
import { SourceFile } from '../../models/sourceFile.model.js';
import { SourceVersion } from '../../models/sourceVersion.model.js';

export const SOURCE_MODELS = Object.freeze([SourceVersion, SourceFile, SourceChangeSummary]);
export const DOCUMENT_MODELS = Object.freeze([DocumentSection]);
export const KNOWLEDGE_MODELS = Object.freeze([KnowledgeVersion]);
export const REPOSITORY_MODELS = Object.freeze([RepositoryConnection]);
