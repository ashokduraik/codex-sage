import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RegisterPage from '@/features/auth/RegisterPage';
import { AUTH_STORAGE_KEY } from '@/features/auth/AuthContext';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
describe('RegisterPage', () => {
    beforeEach(() => {
        clearAuthSession();
        localStorage.clear();
    });
    it('advances from register form to OTP verification', async () => {
        renderWithProviders(<RegisterPage />, { route: '/register' });
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'newbie@acme.io' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'password123' },
        });
        fireEvent.change(screen.getByLabelText('Confirm Password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
        expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeTruthy();
        expect(screen.getByText(/newbie@acme.io/i)).toBeTruthy();
    });
    it('verifies a six-character OTP and establishes a session', async () => {
        renderWithProviders(<RegisterPage />, { route: '/register' });
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'otp.user@acme.io' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'password123' },
        });
        fireEvent.change(screen.getByLabelText('Confirm Password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
        await screen.findByRole('heading', { name: 'Verify your email' });
        const otpInput = document.querySelector('input[autocomplete="one-time-code"]');
        expect(otpInput).toBeTruthy();
        fireEvent.input(otpInput, { target: { value: '123456' } });
        fireEvent.change(otpInput, { target: { value: '123456' } });
        await waitFor(() => {
            const verifyButton = screen.getByRole('button', { name: 'Verify' });
            expect(verifyButton.disabled).toBe(false);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
        await waitFor(() => {
            const raw = localStorage.getItem(AUTH_STORAGE_KEY);
            expect(raw).toBeTruthy();
            expect(JSON.parse(raw).user.email).toBe('otp.user@acme.io');
        });
    });
    it('shows a mismatch error when passwords differ', async () => {
        renderWithProviders(<RegisterPage />, { route: '/register' });
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'mismatch@acme.io' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'password123' },
        });
        fireEvent.change(screen.getByLabelText('Confirm Password'), {
            target: { value: 'different' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/do not match/i);
    });
    it('registers with Google and resends OTP from the verify step', async () => {
        renderWithProviders(<RegisterPage />, { route: '/register' });
        fireEvent.click(screen.getByRole('button', { name: /Continue with Google/i }));
        await waitFor(() => {
            expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeTruthy();
        });
        clearAuthSession();
        localStorage.clear();
        cleanup();
        renderWithProviders(<RegisterPage />, { route: '/register' });
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'resend@acme.io' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'password123' },
        });
        fireEvent.change(screen.getByLabelText('Confirm Password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
        await screen.findByRole('heading', { name: 'Verify your email' });
        fireEvent.click(screen.getByRole('button', { name: /Resend/i }));
    });
});
