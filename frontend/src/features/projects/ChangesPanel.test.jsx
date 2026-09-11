import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import ChangesPanel from './ChangesPanel';
import ProjectDetailPage from './ProjectDetailPage';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('ChangesPanel', () => {
    it('renders change summary for a project with knowledge', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="changes" element={<ChangesPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas/changes' });
        expect(screen.getByRole('heading', { name: 'Changes' })).toBeTruthy();
        expect(screen.getAllByText('Added').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Modified').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Removed').length).toBeGreaterThan(0);
        expect(screen.getByText('src/payments/refund.ts')).toBeTruthy();
        expect(screen.getByText('Checkout confirmation')).toBeTruthy();
        // First conflict starts expanded.
        expect(screen.getByText('Code says')).toBeTruthy();
        fireEvent.click(screen.getByText('Checkout confirmation'));
        expect(screen.queryByText('Code says')).toBeNull();
    });
    it('shows empty state when knowledge tree is empty', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="changes" element={<ChangesPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_helios/changes' });
        expect(screen.getByText('No recent changes')).toBeTruthy();
    });
});
