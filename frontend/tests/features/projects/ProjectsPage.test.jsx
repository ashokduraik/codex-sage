/**
 * ProjectsPage against a mocked projects API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
    patchProject: vi.fn(),
    getProjectDeletionPreview: vi.fn(),
    recordProjectAccess: vi.fn(),
  };
});

import ProjectsPage from '@/features/projects/ProjectsPage';
import { listProjects } from '@/features/projects/api/projectsApi.js';

const SAMPLE = [
  {
    id: 'p1',
    name: 'Atlas Commerce',
    description: 'Checkout',
    lifecycleStatus: 'knowledge_ready',
    knowledgeHealth: 'ready',
    sourceConfig: { sourceType: 'repository' },
    counts: { sourceVersions: 1, files: 10, excludedFiles: 0, conversations: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'p2',
    name: 'Orion Analytics',
    description: 'Analytics',
    lifecycleStatus: 'awaiting_source',
    knowledgeHealth: 'none',
    sourceConfig: { sourceType: 'upload' },
    counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  listProjects.mockResolvedValue({
    items: SAMPLE,
    pageInfo: { nextCursor: null, hasMore: false },
  });
});

describe('ProjectsPage', () => {
  it('lists projects from the API with lifecycle badges', async () => {
    renderWithProviders(<ProjectsPage />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
    expect(screen.getByText('Orion Analytics')).toBeTruthy();
    expect(screen.getByText('Knowledge ready')).toBeTruthy();
  });

  it('sends q to the API instead of filtering locally', async () => {
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('Atlas Commerce');
    fireEvent.change(screen.getByPlaceholderText('Search projects…'), {
      target: { value: 'Atlas' },
    });
    await waitFor(() => expect(listProjects).toHaveBeenCalledWith(expect.objectContaining({ q: 'Atlas' })));
  });

  it('opens the create project dialog', async () => {
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('Atlas Commerce');
    fireEvent.click(screen.getByRole('button', { name: /Create project/i }));
    expect(screen.getByRole('heading', { name: 'Create project' })).toBeTruthy();
  });

  it('toggles archived and shows empty when none returned', async () => {
    listProjects.mockImplementation(async (options) => {
      if (options.includeArchived) {
        return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
      }
      return { items: SAMPLE, pageInfo: { nextCursor: null, hasMore: false } };
    });
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('Atlas Commerce');
    fireEvent.click(screen.getByRole('button', { name: /Active/i }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true })));
    expect(await screen.findByText('No archived projects')).toBeTruthy();
  });

  it('shows load more when nextCursor is present', async () => {
    listProjects
      .mockResolvedValueOnce({
        items: [SAMPLE[0]],
        pageInfo: { nextCursor: 'c2', hasMore: true },
      })
      .mockResolvedValueOnce({
        items: [SAMPLE[1]],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    renderWithProviders(<ProjectsPage />);
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
    expect(await screen.findByText('Orion Analytics')).toBeTruthy();
  });

  it('shows list error with correlation and retry', async () => {
    const { ApiError } = await import('@/shared/api/index');
    listProjects.mockRejectedValue(
      new ApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'list boom',
        correlationId: 'corr-list',
      }),
    );
    renderWithProviders(<ProjectsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('list boom');
    expect(alert.textContent).toContain('corr-list');
    listProjects.mockResolvedValue({
      items: SAMPLE,
      pageInfo: { nextCursor: null, hasMore: false },
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
  });
});
