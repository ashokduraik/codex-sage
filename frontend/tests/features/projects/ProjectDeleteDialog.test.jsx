/**
 * ProjectDeleteDialog preview and confirm paths.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/index';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProjectDeletionPreview: vi.fn(),
    deleteProject: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    patchProject: vi.fn(),
    recordProjectAccess: vi.fn(),
  };
});

import { deleteProject, getProjectDeletionPreview } from '@/features/projects/api/projectsApi.js';
import { ProjectDeleteDialog } from '@/features/projects/ProjectDeleteDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ProjectDeleteDialog', () => {
  it('keeps confirm disabled while preview loads and confirms after', async () => {
    let resolvePreview;
    getProjectDeletionPreview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    deleteProject.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    renderWithProviders(<ProjectDeleteDialog open={true} onOpenChange={() => undefined} projectId="p1" projectName="Atlas" onDeleted={onDeleted} />);
    expect(screen.getByRole('button', { name: /Delete project/i }).disabled).toBe(true);
    resolvePreview({
      counts: { sourceVersions: 1, files: 2, conversations: 3, jobs: 0 },
      consequences: [{ resource: 'conversations', effect: 'soft_deleted', retentionDays: 365 }],
    });
    expect(await screen.findByText(/Conversations: 3/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /Delete project/i });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('p1'));
    expect(onDeleted).toHaveBeenCalled();
  });

  it('shows preview error and does not offer blind delete', async () => {
    getProjectDeletionPreview.mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' }));
    renderWithProviders(<ProjectDeleteDialog open={true} onOpenChange={() => undefined} projectId="p1" projectName="Atlas" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom');
    expect(screen.getByRole('button', { name: /Delete project/i }).disabled).toBe(true);
  });

  it('falls back to generic consequence copy and surfaces forbidden delete', async () => {
    getProjectDeletionPreview.mockResolvedValue({
      counts: { sourceVersions: 0, files: 0, conversations: 0, jobs: 1 },
      consequences: [{ resource: 'widgets', effect: 'purged', retentionDays: null }],
    });
    deleteProject.mockRejectedValue(
      new ApiError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'nope',
        correlationId: 'corr-del',
        retryAfterSeconds: 3,
      }),
    );
    const onOpenChange = vi.fn();
    renderWithProviders(<ProjectDeleteDialog open={true} onOpenChange={onOpenChange} projectId="p1" projectName="Atlas" />);
    expect(await screen.findByText(/widgets/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Delete project/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not allowed|forbidden|permission/i);
    expect(alert.textContent).toContain('corr-del');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
