import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider, AUTH_STORAGE_KEY } from '@/features/auth/AuthContext';
import AppShell from '@/features/layout/AppShell';
import Header from '@/features/layout/Header';
import ProcessingIndicator from '@/features/layout/ProcessingIndicator';
import Sidebar from '@/features/layout/Sidebar';
import NotFoundPage from '@/features/not-found/NotFoundPage';
import '@/shared/i18n';
import { AppDataProvider } from '@/shared/mock-data';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
/** Persist a mock authenticated user for provider tests. */
function seedAuthSession() {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
        id: 'u1',
        email: 'you@acme.io',
        full_name: 'You',
        role: 'admin',
    }));
}
/**
 * Wraps UI under router + auth + mock data providers.
 * @param children - Tree to render.
 * @param initialPath - MemoryRouter initial entry.
 */
function renderWithProviders(children, initialPath = '/') {
    cleanup();
    return render(<MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <AppDataProvider>{children}</AppDataProvider>
      </AuthProvider>
    </MemoryRouter>);
}
describe('Sidebar', () => {
    beforeEach(() => {
        seedAuthSession();
    });
    it('renders nav labels and can collapse to icon mode', () => {
        const { rerender } = renderWithProviders(<Sidebar collapsed={false} onToggle={() => undefined}/>);
        expect(screen.getByText('Home')).toBeTruthy();
        expect(screen.getByText('Codex Sage')).toBeTruthy();
        expect(screen.getByText('Collapse')).toBeTruthy();
        rerender(<MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppDataProvider>
            <Sidebar collapsed={true} onToggle={() => undefined}/>
          </AppDataProvider>
        </AuthProvider>
      </MemoryRouter>);
        expect(screen.queryByText('Collapse')).toBeNull();
        expect(screen.getByLabelText('Expand')).toBeTruthy();
    });
    it('shows the current project when the path matches a project', () => {
        renderWithProviders(<Sidebar collapsed={false} onToggle={() => undefined}/>, '/projects/prj_atlas');
        expect(screen.getByText('Current project')).toBeTruthy();
        expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
    });
});
describe('ProcessingIndicator', () => {
    it('returns null when there is no job', () => {
        const { container } = renderWithProviders(<ProcessingIndicator job={null} project={null}/>);
        expect(container.textContent).toBe('');
    });
    it('renders job progress when a job is active', () => {
        const job = {
            id: 'job1',
            projectId: 'p1',
            op: 'Initial processing',
            status: 'in_progress',
            progress: 42,
            startedAt: new Date().toISOString(),
            stages: [],
            activity: [],
            warnings: [],
            errors: [],
        };
        const project = { id: 'p1', name: 'Atlas' };
        renderWithProviders(<ProcessingIndicator job={job} project={project}/>);
        expect(screen.getByText(/Initial processing/)).toBeTruthy();
        expect(screen.getAllByText(/42%/).length).toBeGreaterThan(0);
    });
});
describe('Header', () => {
    beforeEach(() => {
        seedAuthSession();
    });
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
    it('filters projects in the search dropdown', () => {
        renderWithProviders(<Header />);
        const input = screen.getByPlaceholderText('Search projects…');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'Atlas' } });
        expect(screen.getByText('Atlas Commerce')).toBeTruthy();
    });
});
describe('AppShell', () => {
    beforeEach(() => {
        seedAuthSession();
    });
    it('renders outlet content inside the shell', () => {
        cleanup();
        render(<MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppDataProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<div>Shell child</div>}/>
              </Route>
            </Routes>
          </AppDataProvider>
        </AuthProvider>
      </MemoryRouter>);
        expect(screen.getByText('Shell child')).toBeTruthy();
        expect(screen.getAllByText('Home').length).toBeGreaterThan(0);
    });
});
describe('NotFoundPage', () => {
    it('shows not-found copy and a home link without admin AI hints', () => {
        cleanup();
        render(<MemoryRouter initialEntries={['/missing-page']}>
        <Routes>
          <Route path="*" element={<NotFoundPage />}/>
        </Routes>
      </MemoryRouter>);
        expect(screen.getByText('Page not found')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
        expect(screen.queryByText(/Admin Note/i)).toBeNull();
        expect(screen.queryByText(/AI hasn't implemented/i)).toBeNull();
    });
});
