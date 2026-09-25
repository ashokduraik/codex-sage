import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('./test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

vi.mock('@/features/projects/api/sourcesApi.js', () => ({
  SOURCE_VERSION_LIST_PAGE_SIZE: 20,
  sourceVersionsQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'source-versions']),
  listProjectSourceVersions: vi.fn(),
  uploadProjectSource: vi.fn(),
}));

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  repositoryConnectionQueryKey: (projectId) =>
    Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
  getProjectRepositoryConnection: vi.fn(),
  replaceProjectRepositoryCredential: vi.fn(),
  revokeProjectRepositoryCredential: vi.fn(),
  retestProjectRepositoryConnection: vi.fn(),
  probeProjectRepository: vi.fn(),
  attachProjectRepository: vi.fn(),
  patchProjectRepositoryBranch: vi.fn(),
}));

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';
import { listProjectSourceVersions } from '@/features/projects/api/sourcesApi.js';
import {
  getProjectRepositoryConnection,
  replaceProjectRepositoryCredential,
  revokeProjectRepositoryCredential,
  retestProjectRepositoryConnection,
} from '@/features/projects/api/repositoriesApi.js';
import ProjectDetailPage from './ProjectDetailPage';
import SourcesPanel, { connectionStatusLabelKey } from './SourcesPanel';

const ATLAS_CONNECTION = {
  id: 'rc_atlas',
  provider: 'github',
  selectedBranch: 'main',
  connectionStatus: 'connected',
  lastSuccessfulProbeAt: '2026-01-02T00:00:00.000Z',
  lastSyncedAt: '2026-01-02T00:00:00.000Z',
  repository: {
    fullName: 'acme/atlas-commerce',
    webUrl: 'https://github.com/acme/atlas-commerce',
  },
};

const ATLAS_VERSIONS = {
  items: [
    {
      id: 'sv_atlas',
      origin: 'repository',
      versionLifecycle: 'accepted',
      fileCounts: { accepted: 4812, skipped: 1203, excludedFromGraph: 9 },
      jobId: 'job_atlas',
      commitSha: 'abc123',
      branch: 'main',
      createdBy: 'u1',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ],
  pageInfo: { nextCursor: null, hasMore: false },
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  listProjectSourceVersions.mockReset();
  getProjectRepositoryConnection.mockReset();
  replaceProjectRepositoryCredential.mockReset();
  revokeProjectRepositoryCredential.mockReset();
  retestProjectRepositoryConnection.mockReset();
  listProjectSourceVersions.mockResolvedValue(ATLAS_VERSIONS);
  getProjectRepositoryConnection.mockResolvedValue({ connection: ATLAS_CONNECTION });
  replaceProjectRepositoryCredential.mockResolvedValue({ connection: ATLAS_CONNECTION });
  revokeProjectRepositoryCredential.mockResolvedValue(undefined);
  retestProjectRepositoryConnection.mockResolvedValue({ connectionStatus: 'connected' });
});

/**
 * Renders Sources under the project detail shell.
 * @param {string} [route] Location.
 */
function renderSources(route = '/projects/prj_atlas/sources') {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="sources" element={<SourcesPanel />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('SourcesPanel', () => {
  it('renders repository source details for Atlas', async () => {
    renderSources();
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(await screen.findByText('acme/atlas-commerce')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-test connection/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add source/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View processing job' }).getAttribute('href')).toBe(
      '/processing?projectId=prj_atlas',
    );
  });

  it('shows verified status after re-test completes', async () => {
    let resolveRetest;
    retestProjectRepositoryConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetest = resolve;
        }),
    );
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: /Re-test connection/i }));
    expect(await screen.findByText('Testing connection…')).toBeTruthy();
    expect(retestProjectRepositoryConnection).toHaveBeenCalledWith({
      projectId: 'prj_atlas',
    });
    resolveRetest({ connectionStatus: 'connected' });
    await waitFor(() => {
      expect(screen.getByText('Connection verified.')).toBeTruthy();
    });
  });

  it('opens replace-credentials and saves a new token', async () => {
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: /Replace credentials/i }));
    expect(await screen.findByRole('heading', { name: /Replace credentials/i })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Access token/i), {
      target: { value: 'ghp_replacement_token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save token/i }));
    await waitFor(() => {
      expect(replaceProjectRepositoryCredential).toHaveBeenCalledWith({
        projectId: 'prj_atlas',
        accessToken: 'ghp_replacement_token',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Replace credentials/i })).toBeNull();
    });
  });

  it('revokes repository credentials after confirmation', async () => {
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke \/ disconnect/i }));
    expect(await screen.findByText(/Revoke repository credentials/i )).toBeTruthy();
    const confirmButtons = screen.getAllByRole('button', { name: /^Revoke$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => {
      expect(revokeProjectRepositoryCredential).toHaveBeenCalledWith({
        projectId: 'prj_atlas',
      });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Revoke repository credentials/i )).toBeNull();
    });
  });

  it('shows a forbidden alert when revoke is denied', async () => {
    revokeProjectRepositoryCredential.mockRejectedValue(
      new ApiError({ status: 403, code: 'FORBIDDEN', message: 'nope' }),
    );
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke \/ disconnect/i }));
    const confirmButtons = screen.getAllByRole('button', { name: /^Revoke$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('opens the connect-repository dialog from Add source', async () => {
    renderSources();
    fireEvent.click(await screen.findByRole('button', { name: /Add source/i }));
    expect(await screen.findByRole('heading', { name: 'Connect repository' })).toBeTruthy();
  });

  it('shows empty history when no versions exist', async () => {
    listProjectSourceVersions.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderSources();
    expect(await screen.findByText('No source versions yet.')).toBeTruthy();
  });

  it('shows a retryable error when the versions list fails', async () => {
    listProjectSourceVersions.mockRejectedValue(
      new ApiError({ status: 500, code: 'SYSTEM_ERROR', message: 'boom' }),
    );
    renderSources();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});

describe('connectionStatusLabelKey', () => {
  it('maps known codes and falls back for unknown', () => {
    expect(connectionStatusLabelKey('connected')).toBe('sources.connectionStatus.connected');
    expect(connectionStatusLabelKey('authentication_required')).toBe(
      'sources.connectionStatus.authenticationRequired',
    );
    expect(connectionStatusLabelKey('mystery')).toBe('sources.connectionStatus.unknown');
    expect(connectionStatusLabelKey(null)).toBe('sources.connectionStatus.unknown');
  });
});
