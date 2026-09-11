import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import KnowledgeExplorer from './KnowledgeExplorer';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('KnowledgeExplorer', () => {
    it('renders knowledge tree nodes for Atlas', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="knowledge" element={<KnowledgeExplorer />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas/knowledge' });
        expect(screen.getByRole('heading', { name: 'Knowledge' })).toBeTruthy();
        expect(screen.getByText('Authentication & Authorization')).toBeTruthy();
        expect(screen.getByText('Login flow (email + OAuth Google)')).toBeTruthy();
    });
    it('collapses a capability node when toggled', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="knowledge" element={<KnowledgeExplorer />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas/knowledge' });
        const toggle = screen.getAllByRole('button', { expanded: true })[0];
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
    it('shows empty state when knowledge is missing', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="knowledge" element={<KnowledgeExplorer />}/>
        </Route>
      </Routes>, { route: '/projects/prj_helios/knowledge' });
        expect(screen.getByText('No knowledge yet')).toBeTruthy();
    });
});
