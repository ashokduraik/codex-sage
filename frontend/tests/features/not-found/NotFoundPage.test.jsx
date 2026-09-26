import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import NotFoundPage from '@/features/not-found/NotFoundPage';
afterEach(() => {
  cleanup();
});
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});
describe('NotFoundPage', () => {
  it('shows not-found copy and a home link without admin AI hints', () => {
    renderWithProviders(
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>,
      { route: '/missing-page' },
    );
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.getByText(/missing-page/)).toBeTruthy();
    expect(screen.queryByText(/Admin Note/i)).toBeNull();
    expect(screen.queryByText(/AI hasn't implemented/i)).toBeNull();
  });
  it('omits the quoted path name on the root path', () => {
    renderWithProviders(
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>,
      { route: '/' },
    );
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.queryByText(/""/)).toBeNull();
  });
});
