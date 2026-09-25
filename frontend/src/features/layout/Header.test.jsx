import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProjects = vi.fn(async (options = {}) => ({
  items: options.q
    ? [{ id: 'prj_atlas', name: 'Atlas Commerce', description: '', lifecycleStatus: 'knowledge_ready', knowledgeHealth: 'ready', sourceConfig: { sourceType: 'repository' }, counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    : [
        { id: 'prj_atlas', name: 'Atlas Commerce', description: '', lifecycleStatus: 'knowledge_ready', knowledgeHealth: 'ready', sourceConfig: { sourceType: 'repository' }, counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'prj_orion', name: 'Orion Analytics', description: '', lifecycleStatus: 'awaiting_source', knowledgeHealth: 'none', sourceConfig: { sourceType: 'upload' }, counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
  pageInfo: { nextCursor: null, hasMore: false },
}));
const getProject = vi.fn(async (id) => {
  const fixtures = await import('@/features/projects/test/projectApiFixtures.js');
  return fixtures.resolveTestProject(id);
});
vi.mock('@/features/projects/api/projectsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjects: (...args) => listProjects(...args),
    getProject: (...args) => getProject(...args),
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
    patchProject: vi.fn(),
    getProjectDeletionPreview: vi.fn(),
    recordProjectAccess: vi.fn(async (id) => getProject(id)),
  };
});

const listProjectJobs = vi.fn(async () => ({
  items: [],
  pageInfo: { nextCursor: null, hasMore: false },
}));
vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjectJobs: (...args) => listProjectJobs(...args),
    getJob: vi.fn(),
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
  };
});

import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import Header, { resolveProcessingProjectId } from './Header';
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
describe('Header', () => {
    it('renders org name and search placeholder', () => {
        renderWithProviders(<Header />);
        expect(screen.getByText('Acme Corp')).toBeTruthy();
        expect(screen.getByPlaceholderText('Search projects…')).toBeTruthy();
    });
    it('invokes onMenu when the mobile menu button is clicked', () => {
        let opened = false;
        renderWithProviders(<Header onMenu={() => {
                opened = true;
            }}/>);
        fireEvent.click(screen.getByLabelText('Open menu'));
        expect(opened).toBe(true);
    });
    it('filters projects in the search dropdown', async () => {
        renderWithProviders(<Header />);
        const input = screen.getByPlaceholderText('Search projects…');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Atlas' } });
        expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
    });

    it('shows the active project name from the detail API', async () => {
        renderWithProviders(<Header />, { route: '/projects/prj_atlas' });
        expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
    });

    it('navigates from a search result and closes the dropdown', async () => {
        renderWithProviders(<Header />);
        const input = screen.getByPlaceholderText('Search projects…');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Atlas' } });
        const result = await screen.findByRole('button', { name: /Atlas Commerce/i });
        fireEvent.click(result);
        expect(input.value).toBe('');
    });

    it('closes search results on outside click', async () => {
        renderWithProviders(<Header />);
        const input = screen.getByPlaceholderText('Search projects…');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Atlas' } });
        expect(await screen.findByRole('button', { name: /Atlas Commerce/i })).toBeTruthy();
        fireEvent.mouseDown(document.body);
        expect(screen.queryByRole('button', { name: /Atlas Commerce/i })).toBeNull();
    });

    it('hides the processing chip when the project has no active job', async () => {
        renderWithProviders(<Header />, { route: '/projects/prj_atlas' });
        expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
        expect(screen.queryByText(/· Atlas Commerce/)).toBeNull();
    });

    it('shows the processing chip when the project has a running job', async () => {
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
        renderWithProviders(<Header />, { route: '/projects/prj_atlas' });
        expect(await screen.findByText(/Project structure analyzed · Atlas Commerce/)).toBeTruthy();
        expect(screen.queryByText(/%/)).toBeNull();
    });
});

describe('resolveProcessingProjectId', () => {
  it('prefers the projectId query string', () => {
    const searchParams = new URLSearchParams('projectId=from-query');
    expect(
      resolveProcessingProjectId({
        pathname: '/projects/from-route',
        params: { id: 'from-params' },
        searchParams,
      }),
    ).toBe('from-query');
  });

  it('uses the project route when no query is present', () => {
    expect(
      resolveProcessingProjectId({
        pathname: '/projects/prj_atlas/sources',
        params: { id: 'prj_atlas' },
        searchParams: new URLSearchParams(),
      }),
    ).toBe('prj_atlas');
  });

  it('returns empty on Home and admin', () => {
    expect(
      resolveProcessingProjectId({
        pathname: '/',
        params: {},
        searchParams: new URLSearchParams(),
      }),
    ).toBe('');
    expect(
      resolveProcessingProjectId({
        pathname: '/processing',
        params: {},
        searchParams: new URLSearchParams(),
      }),
    ).toBe('');
  });
});
