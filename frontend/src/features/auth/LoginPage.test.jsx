import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import LoginPage from '@/features/auth/LoginPage';
import { AUTH_STORAGE_KEY, } from '@/features/auth/AuthContext';
import { clearAuthSession, renderWithProviders, } from '@/test/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
describe('LoginPage', () => {
    beforeEach(() => {
        clearAuthSession();
        localStorage.clear();
    });
    it('renders the login form with email, password, and Google button', () => {
        renderWithProviders(<LoginPage />, { route: '/login' });
        expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeTruthy();
        expect(screen.getByLabelText('Email')).toBeTruthy();
        expect(screen.getByLabelText('Password')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    });
    it('submits login and stores an authenticated session', async () => {
        renderWithProviders(<LoginPage />, { route: '/login' });
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'you@acme.io' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'password' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
        await waitFor(() => {
            const raw = localStorage.getItem(AUTH_STORAGE_KEY);
            expect(raw).toBeTruthy();
            expect(JSON.parse(raw).user.email).toBe('you@acme.io');
        });
    });
    it('shows an error when login fails on empty credentials', async () => {
        renderWithProviders(<LoginPage />, { route: '/login' });
        const form = screen.getByLabelText('Email').closest('form');
        expect(form).toBeTruthy();
        fireEvent.submit(form);
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/Email and password are required/i);
    });
    it('signs in with the Google button', async () => {
        renderWithProviders(<LoginPage />, { route: '/login' });
        fireEvent.click(screen.getByRole('button', { name: /Continue with Google/i }));
        await waitFor(() => {
            const raw = localStorage.getItem(AUTH_STORAGE_KEY);
            expect(raw).toBeTruthy();
            expect(JSON.parse(raw).user.email).toBe('google.user@acme.io');
        });
    });
});
