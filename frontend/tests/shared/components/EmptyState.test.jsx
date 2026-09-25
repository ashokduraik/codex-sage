import { Inbox } from 'lucide-react';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import EmptyState from '@/shared/components/EmptyState';
import { clearAuthSession, renderWithProviders } from '@tests/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
describe('EmptyState', () => {
    it('renders title, description, icon, and action', () => {
        clearAuthSession();
        renderWithProviders(<EmptyState icon={Inbox} title="Nothing here" description="Add an item to get started." action={<button type="button">Add</button>} className="custom-empty"/>);
        expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy();
        expect(screen.getByText('Add an item to get started.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    });
    it('omits description and action when not provided', () => {
        renderWithProviders(<EmptyState title="Empty only"/>);
        expect(screen.getByRole('heading', { name: 'Empty only' })).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });
});
