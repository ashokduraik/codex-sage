/**
 * Public surface of the knowledge module (publish, gate, recovery).
 */
export {
  KnowledgeVersion,
  PUBLISHED_HEALTH_VALUES,
} from './knowledgeVersion.model.js';
export {
  countExcludedFromGraphFiles,
  findActiveKnowledgeVersionForSource,
  findKnowledgeVersionById,
  insertKnowledgeVersion,
} from './knowledgeVersion.repository.js';
export {
  KNOWLEDGE_GRAPH_DIR_NAME,
  sanitizeGraphIdentityForPublish,
  resolvePublishedHealth,
  publishKnowledgeVersion,
} from './knowledge.publish.js';
export { assertKnowledgeReadable } from './knowledge.gate.js';
export { knowledgeBrowseRoutes } from './knowledge.routes.js';
export {
  loadKnowledgeBrowse,
  clampBrowseLimit,
  KNOWLEDGE_BROWSE_PAGE_SIZE,
  KNOWLEDGE_BROWSE_MAX_LIMIT,
  KNOWLEDGE_SYMBOL_QUERY_MIN_LEN,
  KNOWLEDGE_SUMMARY_MAX_CHARS,
  mapBrowseFacets,
  emptyBrowseEnvelope,
  mapHealthDimensions,
} from './knowledge.browse.service.js';
export {
  KNOWLEDGE_RECOVERY_MAX_ATTEMPTS,
  wipeCodegraphIndex,
  isRecoverableCodegraphFailure,
  runCodegraphUpdateWithRecovery,
} from './knowledge.recovery.js';

import { KnowledgeVersion } from './knowledgeVersion.model.js';

/** Models whose indexes are synced on development API startup / worker / tests. */
export const KNOWLEDGE_MODELS = Object.freeze([KnowledgeVersion]);
