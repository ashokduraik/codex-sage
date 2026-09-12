/**
 * ProjectDetailPage against mocked detail/mutations.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
  patchProject: vi.fn(),
  getProjectDeletionPreview: vi.fn(),
  recordProjectAccess: vi.fn(async () => ({
      id: 'p1',
      name: 'Atlas Commerce',
      description: 'Checkout',
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'repository' },
      counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastAccessedAt: '2026-01-03T00:00:00.000Z',
    })),
}));

import {
  archiveProject,
  getProject,
  getProjectDeletionPreview,
  recordProjectAccess,
  restoreProject,
} from '@/features/projects/api/projectsApi.js';
import ProjectDetailPage from './ProjectDetailPage';
import ProjectOverview from './ProjectOverview';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  recordProjectAccess.mockImplementation(async (projectId) => ({
    id: projectId,
    name: 'Atlas Commerce',
    description: 'Checkout',
    lifecycleStatus: 'knowledge_ready',
    knowledgeHealth: 'ready',
    sourceConfig: { sourceType: 'repository' },
    counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 2 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastAccessedAt: '2026-01-03T00:00:00.000Z',
  }));
});

describe('ProjectDetailPage', () => {
  it('renders name, lifecycle badge, and records access', async () => {
    getProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas Commerce',
      description: 'Checkout',
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'repository' },
      counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByRole('heading', { name: 'Atlas Commerce' })).toBeTruthy();
    expect(await screen.findByText('Knowledge ready')).toBeTruthy();
    await waitFor(() => expect(recordProjectAccess).toHaveBeenCalledWith('p1'));
    expect(screen.getAllByRole('link', { name: 'Overview' }).length).toBeGreaterThan(0);
  });

  it('shows not found on 404', async () => {
    getProject.mockRejectedValue(
      new ApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>,
      { route: '/projects/missing' },
    );
    expect(await screen.findByText('Project not found.')).toBeTruthy();
  });

  it('shows archived banner and disables chat entry', async () => {
    const archivedProject = {
      id: 'p1',
      name: 'Archived One',
      description: '',
      lifecycleStatus: 'archived',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'upload' },
      counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: '2026-01-03T00:00:00.000Z',
    };
    getProject.mockResolvedValue(archivedProject);
    recordProjectAccess.mockResolvedValue(archivedProject);
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByText(/This project is archived/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Chat' })).toBeNull();
  });

  it('archives from the actions menu', async () => {
    getProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas Commerce',
      description: 'Checkout',
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'repository' },
      counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    archiveProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas Commerce',
      lifecycleStatus: 'archived',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'repository' },
      counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByRole('heading', { name: 'Atlas Commerce' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/Archive Atlas Commerce/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/i }));
    await waitFor(() => expect(archiveProject).toHaveBeenCalledWith('p1'));
  });

  it('surfaces forbidden archive errors inline', async () => {
    getProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas Commerce',
      description: '',
      lifecycleStatus: 'awaiting_source',
      knowledgeHealth: 'none',
      sourceConfig: { sourceType: 'upload' },
      counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    archiveProject.mockRejectedValue(
      new ApiError({ status: 403, code: 'FORBIDDEN', message: 'nope' }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByRole('heading', { name: 'Atlas Commerce' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Archive$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/permission/i);
  });

  it('restores from the archived banner', async () => {
    const archivedProject = {
      id: 'p1',
      name: 'Archived One',
      description: '',
      lifecycleStatus: 'archived',
      knowledgeHealth: 'ready',
      sourceConfig: { sourceType: 'upload' },
      counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: '2026-01-03T00:00:00.000Z',
    };
    getProject.mockResolvedValue(archivedProject);
    recordProjectAccess.mockResolvedValue(archivedProject);
    restoreProject.mockResolvedValue({
      ...archivedProject,
      lifecycleStatus: 'awaiting_source',
      archivedAt: null,
    });
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByText(/This project is archived/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    await waitFor(() => expect(restoreProject).toHaveBeenCalledWith('p1'));
  });

  it('opens delete dialog from the actions menu', async () => {
    getProject.mockResolvedValue({
      id: 'p1',
      name: 'Atlas Commerce',
      description: '',
      lifecycleStatus: 'awaiting_source',
      knowledgeHealth: 'none',
      sourceConfig: { sourceType: 'upload' },
      counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    getProjectDeletionPreview.mockResolvedValue({
      counts: { sourceVersions: 0, files: 0, conversations: 0, jobs: 0 },
      consequences: [],
    });
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/p1' },
    );
    expect(await screen.findByRole('heading', { name: 'Atlas Commerce' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Delete Atlas Commerce/);
    });
  });

  it('shows detail load error with retry', async () => {
    getProject.mockRejectedValue(
      new ApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'detail boom',
        correlationId: 'corr-detail',
      }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>,
      { route: '/projects/p1' },
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('detail boom');
    expect(alert.textContent).toContain('corr-detail');
  });
});
