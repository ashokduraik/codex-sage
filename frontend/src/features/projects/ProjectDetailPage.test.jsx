import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
describe('ProjectDetailPage', () => {
    it('renders tabs for a known project', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas' });
        expect(screen.getByRole('heading', { name: 'Atlas Commerce' })).toBeTruthy();
        expect(screen.getAllByRole('link', { name: 'Overview' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Chat' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Knowledge' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Search' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Changes' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Sources' }).length).toBeGreaterThan(0);
        expect(screen.getAllByRole('link', { name: 'Health' }).length).toBeGreaterThan(0);
    });
    it('shows not found for an unknown project id', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}/>
      </Routes>, { route: '/projects/prj_missing' });
        expect(screen.getByText('Project not found.')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Back to projects/i })).toBeTruthy();
    });
});
