import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProjects = vi.fn(async (options = {}) => ({
  items: options.q
    ? [
        {
          id: 'prj_atlas',
          name: 'Atlas Commerce',
          description: '',
          lifecycleStatus: 'knowledge_ready',
          knowledgeHealth: 'ready',
          sourceConfig: { sourceType: 'repository' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    : [
        {
          id: 'prj_atlas',
          name: 'Atlas Commerce',
          description: '',
          lifecycleStatus: 'knowledge_ready',
          knowledgeHealth: 'ready',
          sourceConfig: { sourceType: 'repository' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'prj_orion',
          name: 'Orion Analytics',
          description: '',
          lifecycleStatus: 'awaiting_source',
          knowledgeHealth: 'none',
          sourceConfig: { sourceType: 'upload' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
  pageInfo: { nextCursor: null, hasMore: false },
}));
const getProject = vi.fn(async (id) => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.resolveTestProject(id);
});
vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: (...args) => listProjects(...args),
    getProject: (...args) => getProject(...args),
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
    patchProject: vi.fn(),
    getProjectDeletionPreview: vi.fn(),
    recordProjectAccess: vi.fn(async (id) => getProject(id)),
  };
});

import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import Sidebar from '@/features/layout/Sidebar';
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});
describe('Sidebar', () => {
  it('renders nav labels and can collapse to icon mode', () => {
    const onToggle = vi.fn();
    renderWithProviders(<Sidebar collapsed={false} onToggle={onToggle} />);
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Codex Sage')).toBeTruthy();
    expect(screen.getByText('Collapse')).toBeTruthy();
    fireEvent.click(screen.getByText('Collapse'));
    expect(onToggle).toHaveBeenCalled();
    cleanup();
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
    renderWithProviders(<Sidebar collapsed={true} onToggle={onToggle} />);
    expect(screen.queryByText('Collapse')).toBeNull();
    expect(screen.getByLabelText('Expand')).toBeTruthy();
  });
  it('shows the current project when path matches a project', async () => {
    renderWithProviders(<Sidebar collapsed={false} onToggle={() => undefined} />, { route: '/projects/prj_atlas' });
    expect(await screen.findByText('Current project')).toBeTruthy();
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
  });
});
