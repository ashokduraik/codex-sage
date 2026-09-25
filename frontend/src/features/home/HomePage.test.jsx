/**
 * HomePage recent projects from API.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

const listProjects = vi.fn();

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: (...args) => listProjects(...args),
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

import HomePage from './HomePage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('HomePage', () => {
  it('renders recently accessed projects and knowledge badges', async () => {
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
          lastAccessedAt: '2026-01-02T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('Recently accessed')).toBeTruthy();
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(
      listProjects.mock.calls.some((call) => call[0]?.sort === 'lastAccessedAt'),
    ).toBe(true);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Atlas Commerce');
    });
    expect(document.body.textContent).toContain('Ready');
  });

  it('shows empty copy when there are no projects', async () => {
    listProjects.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });

  it('shows loading then error with retry for recent projects', async () => {
    let rejectList;
    listProjects.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectList = reject;
      }),
    );
    renderWithProviders(<HomePage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    rejectList(
      new ApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'home list failed',
        correlationId: 'corr-home',
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('home list failed');
    expect(alert.textContent).toContain('corr-home');
    listProjects.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });

  it('enables suggested questions when a recent project exists', async () => {
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
          lastAccessedAt: '2026-01-02T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderWithProviders(<HomePage />);
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Explain this project/i }).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: /Explain this project/i }));
  });
});
