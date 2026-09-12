/**
 * Shared API project fixtures for detail-shell panel tests.
 */
import { vi } from 'vitest';

export const ATLAS_API_PROJECT = {
  id: 'prj_atlas',
  name: 'Atlas Commerce',
  description:
    'Headless e-commerce platform for multi-brand checkout and payments.',
  lifecycleStatus: 'knowledge_ready',
  knowledgeHealth: 'ready',
  sourceConfig: { sourceType: 'repository' },
  counts: { sourceVersions: 3, files: 4812, excludedFiles: 9, conversations: 12 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

export const ORION_API_PROJECT = {
  id: 'prj_orion',
  name: 'Orion Analytics',
  description: 'Analytics warehouse and reporting.',
  lifecycleStatus: 'partially_available',
  knowledgeHealth: 'partial',
  sourceConfig: { sourceType: 'upload' },
  counts: { sourceVersions: 1, files: 100, excludedFiles: 5, conversations: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

export const HELIOS_API_PROJECT = {
  id: 'prj_helios',
  name: 'Helios Gateway',
  description: 'API gateway.',
  lifecycleStatus: 'updating',
  knowledgeHealth: 'updating',
  sourceConfig: { sourceType: 'repository' },
  counts: { sourceVersions: 2, files: 200, excludedFiles: 0, conversations: 1 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const BY_ID = {
  prj_atlas: ATLAS_API_PROJECT,
  prj_orion: ORION_API_PROJECT,
  prj_helios: HELIOS_API_PROJECT,
};

/**
 * Registers a vitest mock for ./api/projectsApi.js (call from test files after vi.mock).
 * @returns {void}
 */
export function mockProjectsApiModule() {
  // no-op placeholder — tests use vi.mock inline with BY_ID
}

/**
 * Default getProject implementation for panel tests.
 * @param {string} projectId Project id.
 * @returns {Promise<object>}
 */
export async function resolveTestProject(projectId) {
  const project = BY_ID[projectId];
  if (!project) {
    const { ApiError } = await import('@/shared/api');
    throw new ApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
  }
  return project;
}

export const defaultProjectsApiMock = {
  getProject: vi.fn(resolveTestProject),
  listProjects: vi.fn(async () => ({
    items: [],
    pageInfo: { nextCursor: null, hasMore: false },
  })),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
  patchProject: vi.fn(),
  getProjectDeletionPreview: vi.fn(),
  recordProjectAccess: vi.fn(async (projectId) => resolveTestProject(projectId)),
};
