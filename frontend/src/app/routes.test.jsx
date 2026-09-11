import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '@/app/routes';
import { AuthProvider, AUTH_STORAGE_KEY } from '@/features/auth/AuthContext';
import ForgotPasswordPage from '@/features/auth/ForgotPasswordPage';
import LoginPage from '@/features/auth/LoginPage';
import RegisterPage from '@/features/auth/RegisterPage';
import ResetPasswordPage from '@/features/auth/ResetPasswordPage';
import '@/shared/i18n';
import { AppDataProvider } from '@/shared/mock-data';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
/**
 * Renders a page under a memory router with auth + app data providers.
 * @param element - Element to render.
 */
function renderPage(element) {
    cleanup();
    return render(<MemoryRouter>
      <AuthProvider>
        <AppDataProvider>{element}</AppDataProvider>
      </AuthProvider>
    </MemoryRouter>);
}
describe('auth pages', () => {
    it('renders localized titles', () => {
        renderPage(<LoginPage />);
        expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeTruthy();
        renderPage(<RegisterPage />);
        expect(screen.getByRole('heading', { name: 'Create your account' })).toBeTruthy();
        renderPage(<ForgotPasswordPage />);
        expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();
        renderPage(<ResetPasswordPage />);
        expect(screen.getByRole('heading', { name: 'Invalid reset link' })).toBeTruthy();
    });
});
describe('AppRoutes', () => {
    it('shows login for protected routes when unauthenticated', async () => {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        render(<MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppDataProvider>
            <AppRoutes />
          </AppDataProvider>
        </AuthProvider>
      </MemoryRouter>);
        expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    });
    it('renders home when authenticated', async () => {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
            id: 'u1',
            email: 'you@acme.io',
            full_name: 'You',
            role: 'admin',
        }));
        render(<MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppDataProvider>
            <AppRoutes />
          </AppDataProvider>
        </AuthProvider>
      </MemoryRouter>);
        expect(await screen.findByRole('heading', { name: 'Understand your software system.' })).toBeTruthy();
    });
});
