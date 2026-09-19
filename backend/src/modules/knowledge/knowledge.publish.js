/**
 * S5 knowledge publish — insert KnowledgeVersion and audit completion.
 */
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { recordAuditEvent } from '../audit/index.js';
import {
  countExcludedFromGraphFiles,
  findActiveKnowledgeVersionForSource,
  insertKnowledgeVersion,
} from './knowledgeVersion.repository.js';

/** Relative graph directory name stored on KnowledgeVersion (never an absolute path). */
export const KNOWLEDGE_GRAPH_DIR_NAME = '.codegraph';

/**
 * Builds a persistable graphIdentity without absolute filesystem paths.
 * @param {object} identity S4 validation identity.
 * @returns {object}
 */
export function sanitizeGraphIdentityForPublish(identity) {
  return {
    graphHash: identity.graphHash ?? null,
    indexedAt: String(identity.indexedAt),
    sourceVersionId: String(identity.sourceVersionId),
    indexedFileCount: Math.max(0, Math.floor(Number(identity.indexedFileCount) || 0)),
    skippedFileCount: Math.max(0, Math.floor(Number(identity.skippedFileCount) || 0)),
    mode: identity.mode === 'sync' ? 'sync' : 'indexAll',
    graphDir: KNOWLEDGE_GRAPH_DIR_NAME,
  };
}

/**
 * Resolves published health from exclusion count.
 * @param {number} excludedFileCount Excluded stored files.
 * @returns {'ready' | 'partially_available'}
 */
export function resolvePublishedHealth(excludedFileCount) {
  return excludedFileCount > 0 ? 'partially_available' : 'ready';
}

/**
 * Publishes a KnowledgeVersion for the job's source version.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   graphIdentity: object,
 *   correlationId?: string | null,
 *   log?: { error?: Function },
 * }} input Publish inputs.
 * @returns {Promise<{
 *   knowledgeVersionId: string,
 *   publishedHealth: 'ready' | 'partially_available',
 *   excludedFileCount: number,
 *   reused: boolean,
 *   outcome: 'completed' | 'completed_with_warnings',
 * }>}
 */
export async function publishKnowledgeVersion(input) {
  if (!input.graphIdentity || typeof input.graphIdentity !== 'object') {
    throw createJobFailureError({
      failureClass: 'permanent',
      code: 'INGEST_MISSING_GRAPH_IDENTITY',
      message: 'Knowledge publish requires a validated graph identity from the code index stage.',
    });
  }

  const excludedFileCount = await countExcludedFromGraphFiles({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  const publishedHealth = resolvePublishedHealth(excludedFileCount);
  const graphIdentity = sanitizeGraphIdentityForPublish(input.graphIdentity);

  const existing = await findActiveKnowledgeVersionForSource({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
  });
  if (
    existing &&
    existing.graphIdentity?.graphHash === graphIdentity.graphHash &&
    existing.publishedHealth === publishedHealth
  ) {
    return {
      knowledgeVersionId: String(existing._id),
      publishedHealth,
      excludedFileCount,
      reused: true,
      outcome: excludedFileCount > 0 ? 'completed_with_warnings' : 'completed',
    };
  }

  const created = await insertKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    graphIdentity,
    publishedHealth,
    excludedFileCount,
    createdBy: null,
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: null,
      action: 'knowledge.completed',
      resourceType: 'knowledge',
      resourceId: String(created._id),
      result: 'success',
      correlationId: input.correlationId ?? null,
      context: {
        projectId: String(input.projectId),
        sourceVersionId: String(input.sourceVersionId),
        knowledgeVersionId: String(created._id),
        publishedHealth,
        excludedFileCount,
      },
    },
    { log: input.log },
  );

  return {
    knowledgeVersionId: String(created._id),
    publishedHealth,
    excludedFileCount,
    reused: false,
    outcome: excludedFileCount > 0 ? 'completed_with_warnings' : 'completed',
  };
}
