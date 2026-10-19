import { ApiError } from '@/shared/api/index';
import { Route, Routes } from 'react-router-dom';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('./test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

vi.mock('@/features/projects/api/repositoriesApi.js', () => ({
  repositoryConnectionQueryKey: (projectId) => Object.freeze(['projects', String(projectId), 'repositories', 'connection']),
  getProjectRepositoryConnection: vi.fn(),
}));

import HealthPanel from '@/features/projects/HealthPanel';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import { getProjectRepositoryConnection } from '@/features/projects/api/repositoriesApi.js';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

const ATLAS_CONNECTION = {
  connection: {
    id: 'rc_atlas',
    provider: 'github',
    selectedBranch: 'main',
    connectionStatus: 'connected',
    repository: { fullName: 'acme/atlas-commerce' },
  },
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  // Health tab requires knowledge.view (ProjectDetailPage outlet gate).
  seedAuthSession('you@acme.io', { permissions: ['knowledge.view'] });
  getProjectRepositoryConnection.mockReset();
  getProjectRepositoryConnection.mockImplementation(async (projectId) => {
    if (projectId === 'prj_atlas' || projectId === 'prj_helios') {
      return ATLAS_CONNECTION;
    }
    throw new ApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
  });
});

/**
 * Renders Health under the project detail shell.
 * @param {string} route Location.
 */
function renderHealth(route) {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="health" element={<HealthPanel />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('HealthPanel', () => {
  it('renders health checks for Atlas', async () => {
    renderHealth('/projects/prj_atlas/health');
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
    expect(screen.getByText('Source connected')).toBeTruthy();
    expect(await screen.findByText('acme/atlas-commerce')).toBeTruthy();
    expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getByText('4,812 files mapped')).toBeTruthy();
  });

  it('renders partial health details for Orion', async () => {
    renderHealth('/projects/prj_orion/health');
    await waitFor(() => expect(screen.getAllByText('Orion Analytics').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Partially available').length).toBeGreaterThan(0);
    expect(screen.getByText(/Some paths were excluded/)).toBeTruthy();
  });

  it('renders updating health details for Helios', async () => {
    renderHealth('/projects/prj_helios/health');
    await waitFor(() => expect(screen.getAllByText('Helios Gateway').length).toBeGreaterThan(0));
    expect(screen.getByText('Knowledge is currently updating.')).toBeTruthy();
  });

  it('renders ready health details for Atlas', async () => {
    renderHealth('/projects/prj_atlas/health');
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
    expect(screen.getByText('Knowledge is ready for grounded answers.')).toBeTruthy();
  });

  it('does not show Open chat, Knowledge, or Processing action buttons', async () => {
    renderHealth('/projects/prj_atlas/health');
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
    // Former bottom CTAs used buttons; project tabs remain as links only.
    expect(screen.queryByRole('link', { name: /Open chat/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Open chat/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Knowledge$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Processing$/i })).toBeNull();
  });
});
