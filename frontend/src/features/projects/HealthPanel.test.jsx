import { cleanup, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('./test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

import HealthPanel from './HealthPanel';
import ProjectDetailPage from './ProjectDetailPage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('HealthPanel', () => {
  it('renders health checks for Atlas', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/health' },
    );
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
    expect(screen.getByText('Source connected')).toBeTruthy();
    expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();
    expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
  });

  it('renders partial health details for Orion', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_orion/health' },
    );
    await waitFor(() =>
      expect(screen.getAllByText('Orion Analytics').length).toBeGreaterThan(0),
    );
  });

  it('renders updating health details for Helios', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_helios/health' },
    );
    await waitFor(() =>
      expect(screen.getAllByText('Helios Gateway').length).toBeGreaterThan(0),
    );
  });

  it('renders ready health details for Atlas', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/health' },
    );
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
  });
});
