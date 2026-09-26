import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProjects = vi.fn(async (options = {}) => ({
  items: options.q
    ? [
        {
          id: 'prj_atlas',
          name: 'Atlas Commerce',
          description: '',
          lifecycleStatus: 'knowledge_ready',
          knowledgeHealth: 'ready',
          sourceConfig: { sourceType: 'repository' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    : [
        {
          id: 'prj_atlas',
          name: 'Atlas Commerce',
          description: '',
          lifecycleStatus: 'knowledge_ready',
          knowledgeHealth: 'ready',
          sourceConfig: { sourceType: 'repository' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'prj_orion',
          name: 'Orion Analytics',
          description: '',
          lifecycleStatus: 'awaiting_source',
          knowledgeHealth: 'none',
          sourceConfig: { sourceType: 'upload' },
          counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
  pageInfo: { nextCursor: null, hasMore: false },
}));
const getProject = vi.fn(async (id) => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
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

import { AuthProvider } from '@/features/auth/AuthContext';
import { CURRENT_USER_QUERY_KEY } from '@/features/auth/api/authApi.js';
import AppShell from '@/features/layout/AppShell';
import Header from '@/features/layout/Header';
import ProcessingIndicator from '@/features/layout/ProcessingIndicator';
import Sidebar from '@/features/layout/Sidebar';
import NotFoundPage from '@/features/not-found/NotFoundPage';
import '@/shared/i18n';
import { setAccessToken } from '@/shared/api';
import { AppDataProvider } from '@/shared/mock-data';
import { buildTestAuthUser, clearAuthSession, seedAuthSession } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
  clearAuthSession();
});

/**
 * Wraps UI under query + router + auth + mock data providers.
 * @param children - Tree to render.
 * @param initialPath - MemoryRouter initial entry.
 */
function renderLayout(children, initialPath = '/') {
  cleanup();
  const user = seedAuthSession();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  setAccessToken('test-access-token');
  queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <AppDataProvider>{children}</AppDataProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    clearAuthSession();
  });

  it('renders nav labels and can collapse to icon mode', () => {
    const { rerender } = renderLayout(<Sidebar collapsed={false} onToggle={() => undefined} />);
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Codex Sage')).toBeTruthy();
    expect(screen.getByText('Collapse')).toBeTruthy();

    const user = buildTestAuthUser();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setAccessToken('test-access-token');
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <AppDataProvider>
              <Sidebar collapsed={true} onToggle={() => undefined} />
            </AppDataProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Collapse')).toBeNull();
    expect(screen.getByLabelText('Expand')).toBeTruthy();
  });

  it('shows the current project when the path matches a project', async () => {
    renderLayout(<Sidebar collapsed={false} onToggle={() => undefined} />, '/projects/prj_atlas');
    expect(await screen.findByText('Current project')).toBeTruthy();
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
  });
});

describe('ProcessingIndicator', () => {
  it('returns null when there is no job', () => {
    const { container } = renderLayout(<ProcessingIndicator job={null} project={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders the stage label when a job is active', () => {
    const job = {
      id: 'job1',
      projectId: 'p1',
      jobType: 'ingest',
      jobStatus: 'running',
      currentStage: 'codegraph_update',
    };
    const project = { id: 'p1', name: 'Atlas' };
    const { container } = renderLayout(<ProcessingIndicator job={job} project={project} />);
    expect(screen.getByText(/Project structure analyzed · Atlas/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/%/);
  });
});

describe('Header', () => {
  beforeEach(() => {
    clearAuthSession();
  });

  it('renders org name and search placeholder', () => {
    renderLayout(<Header />);
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search projects…')).toBeTruthy();
  });

  it('invokes onMenu when the mobile menu button is clicked', () => {
    let opened = false;
    renderLayout(
      <Header
        onMenu={() => {
          opened = true;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(opened).toBe(true);
  });

  it('filters projects in the search dropdown', async () => {
    renderLayout(<Header />);
    const input = screen.getByPlaceholderText('Search projects…');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atlas' } });
    expect(await screen.findByText('Atlas Commerce')).toBeTruthy();
  });
});

describe('AppShell', () => {
  beforeEach(() => {
    clearAuthSession();
  });

  it('renders outlet content inside the shell', () => {
    renderLayout(
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>Shell child</div>} />
        </Route>
      </Routes>,
    );
    expect(screen.getByText('Shell child')).toBeTruthy();
    expect(screen.getAllByText('Home').length).toBeGreaterThan(0);
  });
});

describe('NotFoundPage', () => {
  it('shows not-found copy and a home link without admin AI hints', () => {
    cleanup();
    render(
      <MemoryRouter initialEntries={['/missing-page']}>
        <Routes>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.queryByText(/Admin Note/i)).toBeNull();
    expect(screen.queryByText(/AI hasn't implemented/i)).toBeNull();
  });
});
