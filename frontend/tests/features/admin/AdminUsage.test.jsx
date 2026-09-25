import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@tests/renderWithProviders';
import AdminUsage from '@/features/admin/AdminUsage';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
    if (typeof window.ResizeObserver === 'undefined') {
        class ResizeObserverStub {
            constructor(_callback) { }
            observe() { }
            unobserve() { }
            disconnect() { }
        }
        window.ResizeObserver = ResizeObserverStub;
    }
});
describe('AdminUsage', () => {
    it('renders usage stats and per-user section', () => {
        renderWithProviders(<AdminUsage />);
        expect(screen.getByRole('heading', { name: 'Usage' })).toBeTruthy();
        expect(screen.getByText('Questions asked')).toBeTruthy();
        expect(screen.getByText('1,284')).toBeTruthy();
        expect(screen.getByText('4.2M')).toBeTruthy();
        expect(screen.getByText('Questions by project')).toBeTruthy();
        expect(screen.getByText('Usage by user')).toBeTruthy();
        expect(screen.getByText('You')).toBeTruthy();
    });
});
