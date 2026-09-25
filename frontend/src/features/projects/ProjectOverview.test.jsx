import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('./test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjectJobs: vi.fn(async () => ({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    })),
    getJob: vi.fn(),
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
  };
});

import { listProjectJobs } from '@/features/projects/processing/api/jobsApi.js';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import ProjectDetailPage from './ProjectDetailPage';
import ProjectOverview from './ProjectOverview';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
    listProjectJobs.mockReset();
    listProjectJobs.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
});
describe('ProjectOverview', () => {
    it('renders summary and capabilities for Atlas', async () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas' });
        expect(await screen.findByText('Summary')).toBeTruthy();
        expect(screen.getAllByText(/Headless e-commerce platform/i).length).toBeGreaterThan(0);
        expect(screen.getByText('Capabilities')).toBeTruthy();
        expect(screen.getByText('Authentication & Authorization')).toBeTruthy();
        expect(screen.getByText('Checkout & Payments')).toBeTruthy();
    });

    it('shows a processing banner when a job is active', async () => {
        listProjectJobs.mockResolvedValue({
          items: [
            {
              id: 'job_run',
              jobType: 'ingest',
              jobStatus: 'running',
              currentStage: 'codegraph_update',
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
          pageInfo: { nextCursor: null, hasMore: false },
        });
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas' });
        expect(await screen.findByText(/Processing in progress: Project structure analyzed/)).toBeTruthy();
    });
});
