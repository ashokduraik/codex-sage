/**
 * buildMockProjectBridge mapping coverage.
 */
import { describe, expect, it } from 'vitest';
import { buildMockProjectBridge } from './buildMockProjectBridge.js';

/**
 * @param {Partial<object>} overrides
 */
function apiProject(overrides = {}) {
  return {
    id: 'p1',
    name: 'Nova',
    description: 'desc',
    lifecycleStatus: 'knowledge_ready',
    knowledgeHealth: 'ready',
    sourceConfig: { sourceType: 'upload' },
    counts: { files: 3, excludedFiles: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    ...overrides,
  };
}

describe('buildMockProjectBridge', () => {
  it('overlays API identity onto an existing mock fallback', () => {
    const bridged = buildMockProjectBridge(apiProject({ lifecycleStatus: 'archived', knowledgeHealth: 'stale' }), {
      id: 'old',
      name: 'Old',
      description: 'keep-me',
      knowledgeTree: [{ id: 'n1' }],
    });
    expect(bridged.id).toBe('p1');
    expect(bridged.name).toBe('Nova');
    expect(bridged.status).toBe('Archived');
    expect(bridged.knowledgeStatus).toBe('Outdated');
    expect(bridged.knowledgeTree).toEqual([{ id: 'n1' }]);
  });

  it('builds a synthetic mock for upload and repository sources', () => {
    const upload = buildMockProjectBridge(
      apiProject({
        lifecycleStatus: 'unknown_code',
        knowledgeHealth: 'unknown_health',
        description: undefined,
        createdBy: undefined,
        counts: undefined,
        sourceConfig: { sourceType: 'upload' },
      }),
    );
    expect(upload.status).toBe('Creating');
    expect(upload.knowledgeStatus).toBe('Needs attention');
    expect(upload.source.type).toBe('upload');
    expect(upload.fileCount).toBe(0);

    const repo = buildMockProjectBridge(
      apiProject({
        sourceConfig: { sourceType: 'repository' },
        knowledgeHealth: 'failed',
        counts: { files: 2, excludedFiles: 0 },
      }),
    );
    expect(repo.source.type).toBe('repo');
    expect(repo.knowledgeStatus).toBe('Needs attention');
    expect(repo.partial).toBe(false);
  });
});
