/**
 * Project DTO helpers shared by service and routes.
 */

/**
 * Formats a date field as ISO-8601, or empty string when missing.
 * @param {unknown} value Date or string.
 * @returns {string}
 */
function toIsoOrEmpty(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
}

/**
 * Formats a date field as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps a project document to the API DTO.
 * @param {object} project Project document or lean object.
 * @param {{ detail?: boolean }} [options] When detail, include archivedAt and version id.
 * @returns {object}
 */
export function mapProjectToDto(project, options = {}) {
  const detail = options.detail === true;
  const counts = project.counts ?? {};
  const sourceConfig = project.sourceConfig ?? {};
  /** @type {Record<string, unknown>} */
  const source = { sourceType: sourceConfig.sourceType };
  if (sourceConfig.repositoryConnectionId) {
    source.repositoryConnectionId = String(sourceConfig.repositoryConnectionId);
  }
  if (sourceConfig.currentSourceVersionId) {
    source.currentSourceVersionId = String(sourceConfig.currentSourceVersionId);
  }

  /** @type {Record<string, unknown>} */
  const dto = {
    id: String(project._id ?? project.id),
    name: project.name,
    description: project.description ?? '',
    lifecycleStatus: project.lifecycleStatus,
    knowledgeHealth: project.knowledgeHealth,
    sourceConfig: source,
    counts: {
      sourceVersions: counts.sourceVersions ?? 0,
      files: counts.files ?? 0,
      excludedFiles: counts.excludedFiles ?? 0,
      conversations: counts.conversations ?? 0,
    },
    createdBy: project.createdBy ? String(project.createdBy) : null,
    createdAt: toIsoOrEmpty(project.createdAt),
    updatedAt: toIsoOrEmpty(project.updatedAt),
  };

  if (detail) {
    dto.archivedAt = toIsoOrNull(project.archivedAt);
    dto.currentKnowledgeVersionId = project.currentKnowledgeVersionId
      ? String(project.currentKnowledgeVersionId)
      : null;
    dto.settings =
      project.settings && typeof project.settings === 'object' ? { ...project.settings } : {};
    dto.lifecycleStatusReasonCode = project.lifecycleStatusReasonCode ?? null;
    dto.lifecycleStatusChangedAt = toIsoOrNull(project.lifecycleStatusChangedAt);
  }

  return dto;
}
