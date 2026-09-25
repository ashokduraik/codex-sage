/**
 * ProjectPickerPage lists non-archived API projects.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/index';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@tests/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
    patchProject: vi.fn(),
    getProjectDeletionPreview: vi.fn(),
    recordProjectAccess: vi.fn(),
  };
});

import { listProjects } from '@/features/projects/api/projectsApi.js';
import ProjectPickerPage from '@/features/projects/ProjectPickerPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  listProjects.mockResolvedValue({
    items: [
      {
        id: 'p1',
        name: 'Atlas Commerce',
        description: 'Checkout',
        lifecycleStatus: 'knowledge_ready',
        knowledgeHealth: 'ready',
        sourceConfig: { sourceType: 'upload' },
        counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    pageInfo: { nextCursor: null, hasMore: false },
  });
});

describe('ProjectPickerPage', () => {
  it('lists accessible non-archived projects', async () => {
    renderWithProviders(<ProjectPickerPage tab="chat" />);
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
    expect(listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: false }),
    );
  });

  it('shows empty state when there are no projects', async () => {
    listProjects.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderWithProviders(<ProjectPickerPage tab="knowledge" />);
    expect(await screen.findByText(/No projects yet/i)).toBeTruthy();
  });

  it('shows list error with retry', async () => {
    listProjects.mockRejectedValue(
      new ApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'list failed',
        correlationId: 'corr-pick',
      }),
    );
    renderWithProviders(<ProjectPickerPage tab="search" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('list failed');
    expect(alert.textContent).toContain('corr-pick');
    listProjects.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText(/No projects yet/i)).toBeTruthy();
  });
});
