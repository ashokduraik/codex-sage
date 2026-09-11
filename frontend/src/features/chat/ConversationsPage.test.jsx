import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import ConversationsPage from './ConversationsPage';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('ConversationsPage', () => {
    it('lists active conversations and filters by search', () => {
        renderWithProviders(<ConversationsPage />);
        expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy();
        expect(screen.getByText('How does authentication work?')).toBeTruthy();
        expect(screen.getByText('Where is payment implemented?')).toBeTruthy();
        expect(screen.queryByText('Checkout flow walkthrough')).toBeNull();
        fireEvent.change(screen.getByPlaceholderText(/Search conversations/i), {
            target: { value: 'payment' },
        });
        expect(screen.getByText('Where is payment implemented?')).toBeTruthy();
        expect(screen.queryByText('How does authentication work?')).toBeNull();
    });
    it('switches to archived conversations', () => {
        renderWithProviders(<ConversationsPage />);
        fireEvent.click(screen.getByRole('button', { name: /Active/i }));
        expect(screen.getByText('Checkout flow walkthrough')).toBeTruthy();
    });
});
