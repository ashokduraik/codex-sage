/**
 * Maps backend lifecycle codes onto legacy mock status display strings for panels.
 * @param {string} lifecycleStatus Backend code.
 * @returns {string}
 */
function mockStatusFromLifecycle(lifecycleStatus) {
  /** @type {Record<string, string>} */
  const map = {
    creating: 'Creating',
    awaiting_source: 'Awaiting source',
    connecting_repository: 'Connecting repository',
    source_received: 'Source received',
    processing: 'Processing',
    knowledge_ready: 'Knowledge ready',
    updating: 'Updating',
    failed: 'Failed',
    partially_available: 'Partially available',
    archived: 'Archived',
  };
  return map[lifecycleStatus] ?? 'Creating';
}

/**
 * Maps backend knowledgeHealth onto legacy mock knowledge status strings.
 * @param {string} knowledgeHealth Backend code.
 * @returns {string}
 */
function mockKnowledgeFromHealth(knowledgeHealth) {
  /** @type {Record<string, string>} */
  const map = {
    none: 'Needs attention',
    updating: 'Updating',
    ready: 'Ready',
    partial: 'Partially available',
    stale: 'Outdated',
    failed: 'Needs attention',
  };
  return map[knowledgeHealth] ?? 'Needs attention';
}

/**
 * Builds the mock-shaped project bridge for panels still on useAppData fields.
 * @param {import('./api/projectTypes.js').ProjectDto} apiProject API project DTO.
 * @param {object | undefined} mockFallback Optional mock project from AppData.
 * @returns {object} Mock-compatible project for Sources/Health/Chat/Knowledge.
 */
export function buildMockProjectBridge(apiProject, mockFallback) {
  if (mockFallback) {
    return {
      ...mockFallback,
      id: apiProject.id,
      name: apiProject.name,
      description: apiProject.description ?? mockFallback.description,
      status: mockStatusFromLifecycle(apiProject.lifecycleStatus),
      knowledgeStatus: mockKnowledgeFromHealth(apiProject.knowledgeHealth),
    };
  }

  const sourceType = apiProject.sourceConfig?.sourceType;
  return {
    id: apiProject.id,
    name: apiProject.name,
    description: apiProject.description ?? '',
    status: mockStatusFromLifecycle(apiProject.lifecycleStatus),
    knowledgeStatus: mockKnowledgeFromHealth(apiProject.knowledgeHealth),
    knowledgeTree: [],
    fileCount: apiProject.counts?.files ?? 0,
    excludedCount: apiProject.counts?.excludedFiles ?? 0,
    partial: (apiProject.counts?.excludedFiles ?? 0) > 0,
    source:
      sourceType === 'repository'
        ? { type: 'repo', fullName: '', url: '', branch: '' }
        : { type: 'upload', origin: 'Upload' },
    createdAt: apiProject.createdAt,
    createdBy: apiProject.createdBy ?? '',
  };
}
