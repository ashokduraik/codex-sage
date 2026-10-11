/**
 * CreateProjectDialog against mocked create API.
 */
import { ApiError } from '@/shared/api/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProject: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
    patchProject: vi.fn(),
    getProjectDeletionPreview: vi.fn(),
    recordProjectAccess: vi.fn(),
  };
});

import { createProject } from '@/features/projects/api/projectsApi.js';
import { CreateProjectDialog } from '@/features/projects/CreateProjectDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('CreateProjectDialog', () => {
  it('creates via upload path with pending state and hand-off', async () => {
    let resolveCreate;
    createProject.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova Retail' } });
    fireEvent.click(screen.getByText('Upload source'));
    const continueButton = screen.getByRole('button', { name: /Continue to upload/i });
    fireEvent.click(continueButton);
    await waitFor(() => expect(continueButton.getAttribute('aria-busy')).toBe('true'));
    expect(continueButton.disabled).toBe(true);
    resolveCreate({
      id: 'p-new',
      name: 'Nova Retail',
      sourceConfig: { sourceType: 'upload' },
      lifecycleStatus: 'awaiting_source',
      knowledgeHealth: 'none',
    });
    expect(await screen.findByRole('heading', { name: 'Upload source' })).toBeTruthy();
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nova Retail',
        sourceType: 'upload',
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it('renders PROJECT_NAME_TAKEN as role=alert', async () => {
    createProject.mockRejectedValue(new ApiError({ status: 409, code: 'PROJECT_NAME_TAKEN', message: 'Name taken' }));
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dup' } });
    fireEvent.click(screen.getByText('Upload source'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to upload/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Name taken');
  });

  it('opens the connect-repository hand-off', async () => {
    createProject.mockResolvedValue({
      id: 'p-repo',
      name: 'Repo Project',
      sourceConfig: { sourceType: 'repository' },
      lifecycleStatus: 'connecting_repository',
      knowledgeHealth: 'none',
    });
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Repo Project' } });
    fireEvent.click(screen.getByText('Connect repository'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to connect/i }));
    expect(await screen.findByRole('heading', { name: 'Connect repository' })).toBeTruthy();
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'repository' }));
  });

  it('keeps continue disabled until name and source type are set', () => {
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={() => undefined} />);
    expect(screen.getByRole('button', { name: /Next/i }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova Retail' } });
    expect(screen.getByRole('button', { name: /Next/i }).disabled).toBe(true);
  });

  it('shows correlation and retry-after on create failure', async () => {
    createProject.mockRejectedValue(
      new ApiError({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many',
        correlationId: 'corr-create',
        retryAfterSeconds: 9,
      }),
    );
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'A retail catalog' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova' } });
    fireEvent.click(screen.getByText('Upload source'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to upload/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many');
    expect(alert.textContent).toContain('corr-create');
    expect(alert.textContent).toMatch(/9/);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova 2' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resets and closes when cancel is clicked', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<CreateProjectDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Temp' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
