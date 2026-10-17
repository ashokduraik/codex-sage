/**
 * Public surface of the knowledge module (source, ingest, browse, search).
 */
import { SourceFile } from '../../models/sourceFile.model.js';
import { SourceVersion } from '../../models/sourceVersion.model.js';
import { DocumentSection } from '../../models/documentSection.model.js';
import { KnowledgeVersion } from '../../models/knowledgeVersion.model.js';
import { SourceChangeSummary } from '../../models/sourceChangeSummary.model.js';
import { RepositoryConnection } from '../../models/repositoryConnection.model.js';

export { UPLOAD_MAX_ARCHIVE_BYTES, consumeSourceArchivePreHandler, uploadProjectSourceHttp } from './uploads.js';
export { MULTIPART_MAX_FILES, listProjectSourceVersionsHttp, reingestSourceHttp } from './sources.js';
export { getLatestKnowledgeUpdateHttp } from './changeSummary.js';
export {
  loadSourceFileSlice,
  SOURCE_PREVIEW_MAX_BYTES,
  SOURCE_PREVIEW_MAX_LINES,
  readSourceFileSliceHttp,
  getSourceFileMetadataHttp,
} from './sourcePreview.js';
export {
  probeRepositoryHttp,
  attachRepositoryHttp,
  syncRepositoryHttp,
  getRepositoryConnectionHttp,
  updateRepositoryBranchHttp,
  replaceRepositoryCredentialHttp,
  revokeRepositoryCredentialHttp,
  retestRepositoryConnectionHttp,
} from './repositories.js';
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
  loadKnowledgeBrowse,
  clampBrowseLimit,
  KNOWLEDGE_SUMMARY_MAX_CHARS,
  mapBrowseFacets,
  emptyBrowseEnvelope,
  mapHealthDimensions,
  isRecoverableCodegraphFailure,
  runCodegraphUpdateWithRecovery,
  getKnowledgeSummaryHttp,
  listKnowledgeWorkflowsHttp,
  listKnowledgeApisHttp,
  listKnowledgeSymbolsHttp,
  getKnowledgeHealthHttp,
  getKnowledgeIndexHttp,
} from './knowledge.js';
export { searchProjectHttp, SEARCH_DOC_MAX_RESULTS, SEARCH_GRAPH_MAX_RESULTS, SEARCH_SNIPPET_MAX_CHARS } from './search.js';
export { createCodegraphAdapter, CODEGRAPH_READ_LEASE_TTL_MS } from './codegraph.js';
export { resolveProjectWorkspacePath } from './sources.js';
export { isDocumentPath, listDocumentFilesForVersion, listSectionsForPath, searchDocumentSections } from './documents.js';

export const SOURCE_MODELS = Object.freeze([SourceVersion, SourceFile, SourceChangeSummary]);
export const DOCUMENT_MODELS = Object.freeze([DocumentSection]);
export const KNOWLEDGE_MODELS = Object.freeze([KnowledgeVersion]);
export const REPOSITORY_MODELS = Object.freeze([RepositoryConnection]);
