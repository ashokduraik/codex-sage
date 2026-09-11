import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
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
    it('renders health checks for Atlas', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas/health' });
        expect(screen.getByRole('heading', { name: 'Health' })).toBeTruthy();
        expect(screen.getByText('Source connected')).toBeTruthy();
        expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();
        expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
    });
    it('renders partial health details for Orion', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_orion/health' });
        expect(screen.getAllByText('Orion Analytics').length).toBeGreaterThan(0);
    });
    it('renders updating health details for Helios', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_helios/health' });
        expect(screen.getAllByText('Helios Gateway').length).toBeGreaterThan(0);
    });
    it('renders ready health details for Atlas', () => {
        renderWithProviders(<Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="health" element={<HealthPanel />}/>
        </Route>
      </Routes>, { route: '/projects/prj_atlas/health' });
        expect(screen.getByRole('heading', { name: 'Health' })).toBeTruthy();
        expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
        expect(screen.getByText(/acme\/atlas-commerce/i)).toBeTruthy();
    });
});
