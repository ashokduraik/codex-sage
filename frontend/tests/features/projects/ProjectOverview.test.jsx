import { Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('./test/projectApiFixtures.js');
  return {
    ...fixtures.defaultProjectsApiMock,
    fillProjectDescriptionFromReadme: vi.fn(),
  };
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

import ProjectOverview from '@/features/projects/ProjectOverview';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import { listProjectJobs } from '@/features/projects/processing/api/jobsApi.js';
import { fillProjectDescriptionFromReadme } from '@/features/projects/api/projectsApi.js';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

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

/**
 * Renders Overview with an explicit outlet context (no mock AppData tree).
 * @param {{ project: object, mockProject?: object }} context Outlet context.
 */
function renderOverviewWithContext(context) {
  return renderWithProviders(
    <Routes>
      <Route element={<Outlet context={context} />}>
        <Route index element={<ProjectOverview />} />
      </Route>
    </Routes>,
    { route: '/' },
  );
}

describe('ProjectOverview', () => {
  it('renders summary and capabilities for Atlas', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas' },
    );
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
          jobType: 'project_knowledge_build',
          jobStatus: 'running',
          currentStage: 'codegraph_update',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas' },
    );
    expect(await screen.findByText(/Processing in progress: Project structure analyzed/)).toBeTruthy();
  });

  it('does not show Knowledge map not ready when health is ready and mock tree is empty', () => {
    renderOverviewWithContext({
      project: {
        id: 'prj_api_only',
        name: 'prepayment advisor',
        description: '',
        knowledgeHealth: 'ready',
        lifecycleStatus: 'knowledge_ready',
        counts: { files: 149, excludedFiles: 0 },
      },
      mockProject: { knowledgeTree: [], fileCount: 149, excludedCount: 0 },
    });
    expect(screen.getByText('149 files mapped')).toBeTruthy();
    expect(screen.getByText('The knowledge map covers the connected source.')).toBeTruthy();
    expect(screen.queryByText('Knowledge map not ready')).toBeNull();
    expect(screen.getByRole('link', { name: /Open chat/i })).toBeTruthy();
  });

  it('shows Fill from README when the user can update and a source version exists', async () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: ['projects.update'] });
    fillProjectDescriptionFromReadme.mockReset();
    fillProjectDescriptionFromReadme.mockResolvedValue({
      id: 'prj_api_only',
      name: 'prepayment advisor',
      description: 'A short blurb from README.',
      knowledgeHealth: 'ready',
      lifecycleStatus: 'knowledge_ready',
      sourceConfig: { sourceType: 'upload', currentSourceVersionId: 'sv1' },
      counts: { files: 149, excludedFiles: 0 },
    });
    renderOverviewWithContext({
      project: {
        id: 'prj_api_only',
        name: 'prepayment advisor',
        description: '',
        knowledgeHealth: 'ready',
        lifecycleStatus: 'knowledge_ready',
        sourceConfig: { sourceType: 'upload', currentSourceVersionId: 'sv1' },
        counts: { files: 149, excludedFiles: 0 },
      },
      mockProject: { knowledgeTree: [], fileCount: 149, excludedCount: 0 },
    });
    const button = screen.getByRole('button', { name: /Fill from README/i });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => {
      expect(fillProjectDescriptionFromReadme).toHaveBeenCalledWith('prj_api_only');
    });
  });

  it('hides Fill from README without projects.update or currentSourceVersionId', () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: ['projects.view'] });
    renderOverviewWithContext({
      project: {
        id: 'prj_api_only',
        name: 'prepayment advisor',
        description: '',
        knowledgeHealth: 'ready',
        lifecycleStatus: 'knowledge_ready',
        sourceConfig: { sourceType: 'upload', currentSourceVersionId: 'sv1' },
        counts: { files: 149, excludedFiles: 0 },
      },
      mockProject: { knowledgeTree: [], fileCount: 149, excludedCount: 0 },
    });
    expect(screen.queryByRole('button', { name: /Fill from README/i })).toBeNull();
  });

  it('shows Knowledge map not ready when health is not askable and mock tree is empty', () => {
    renderOverviewWithContext({
      project: {
        id: 'prj_waiting',
        name: 'Waiting',
        description: '',
        knowledgeHealth: 'updating',
        lifecycleStatus: 'updating',
        counts: { files: 0, excludedFiles: 0 },
      },
      mockProject: { knowledgeTree: [], fileCount: 0, excludedCount: 0 },
    });
    expect(screen.getByText('Knowledge map not ready')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Processing$/i })).toBeTruthy();
  });
});
