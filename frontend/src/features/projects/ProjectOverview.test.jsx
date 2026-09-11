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
describe('ProjectOverview', () => {
    it('renders summary and capabilities for Atlas', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverview />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas' });
        expect(screen.getByText('Summary')).toBeTruthy();
        expect(screen.getAllByText(/Headless e-commerce platform/i).length).toBeGreaterThan(0);
        expect(screen.getByText('Capabilities')).toBeTruthy();
        expect(screen.getByText('Authentication & Authorization')).toBeTruthy();
        expect(screen.getByText('Checkout & Payments')).toBeTruthy();
    });
});
