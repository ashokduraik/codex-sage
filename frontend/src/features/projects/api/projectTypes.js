/**
 * Project DTO shapes consumed by the projects feature (Phase 17/19).
 * Known status codes are documented; runtime values may include unknown strings.
 */

/**
 * @typedef {'creating' | 'awaiting_source' | 'connecting_repository' | 'source_received' |
 *   'processing' | 'knowledge_ready' | 'updating' | 'failed' | 'partially_available' |
 *   'archived' | string} ProjectLifecycleStatus
 */

/**
 * @typedef {'none' | 'updating' | 'ready' | 'partial' | 'stale' | 'failed' | string} KnowledgeHealth
 */

/**
 * @typedef {'upload' | 'repository'} ProjectSourceType
 */

/**
 * @typedef {object} ProjectSourceConfig
 * @property {ProjectSourceType} sourceType How source is expected.
 * @property {string} [repositoryConnectionId] Connected repository id when present.
 * @property {string} [currentSourceVersionId] Current source version id when present.
 */

/**
 * @typedef {object} ProjectCounts
 * @property {number} sourceVersions Stored source version count.
 * @property {number} files Indexed file count.
 * @property {number} excludedFiles Excluded file count.
 * @property {number} conversations Conversation count.
 */

/**
 * @typedef {object} ProjectDto
 * @property {string} id Project id.
 * @property {string} name Display name.
 * @property {string} description Optional description.
 * @property {ProjectLifecycleStatus} lifecycleStatus Backend lifecycle code.
 * @property {KnowledgeHealth} knowledgeHealth Backend knowledge-health code.
 * @property {ProjectSourceConfig} sourceConfig Source configuration.
 * @property {ProjectCounts} counts Aggregate counts.
 * @property {string | null} lastAccessedAt ISO last-access stamp, or null.
 * @property {string | null} createdBy Creator user id.
 * @property {string} createdAt ISO created stamp.
 * @property {string} updatedAt ISO updated stamp.
 * @property {string | null} [archivedAt] Present on detail responses.
 * @property {string | null} [currentKnowledgeVersionId] Present on detail responses.
 * @property {Record<string, unknown>} [settings] Present on detail responses.
 * @property {string | null} [lifecycleStatusReasonCode] Present on detail responses.
 * @property {string | null} [lifecycleStatusChangedAt] Present on detail responses.
 */

/**
 * @typedef {object} ProjectListPage
 * @property {ProjectDto[]} items Page of projects.
 * @property {{ nextCursor: string | null, hasMore: boolean }} pageInfo Keyset page info.
 */

/**
 * @typedef {object} ProjectDeletionConsequence
 * @property {string} resource Affected resource key.
 * @property {string} effect Effect key (e.g. soft_deleted, retained).
 * @property {number | null} retentionDays Retention days when applicable.
 */

/**
 * @typedef {object} ProjectDeletionPreview
 * @property {{
 *   sourceVersions: number,
 *   files: number,
 *   conversations: number,
 *   jobs: number,
 * }} counts Backend-provided counts.
 * @property {ProjectDeletionConsequence[]} consequences Consequence rows.
 */

export {};
