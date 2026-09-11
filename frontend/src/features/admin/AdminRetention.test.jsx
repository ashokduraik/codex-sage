import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import AdminRetention from './AdminRetention';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('AdminRetention', () => {
    it('renders retention policies and toggles a switch', () => {
        renderWithProviders(<AdminRetention />);
        expect(screen.getByRole('heading', { name: 'Retention' })).toBeTruthy();
        expect(screen.getByText('Source retention')).toBeTruthy();
        expect(screen.getByText('Conversation retention')).toBeTruthy();
        expect(screen.getByText('Processing history retention')).toBeTruthy();
        const switches = screen.getAllByRole('switch');
        expect(switches.length).toBeGreaterThanOrEqual(5);
        fireEvent.click(switches[0]);
    });
});
