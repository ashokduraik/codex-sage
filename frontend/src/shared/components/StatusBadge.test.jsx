import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeStatusBadge, ProjectStatusBadge, } from '@/shared/components/StatusBadge';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
});
describe('StatusBadge', () => {
    it('renders a project status label', () => {
        clearAuthSession();
        renderWithProviders(<ProjectStatusBadge status="Knowledge ready"/>);
        expect(screen.getByText('Knowledge ready')).toBeTruthy();
    });
    it('renders a knowledge status label with a status dot', () => {
        renderWithProviders(<KnowledgeStatusBadge status="Ready"/>);
        expect(screen.getByText('Ready')).toBeTruthy();
    });
    it('falls back gracefully for unknown statuses', () => {
        renderWithProviders(<ProjectStatusBadge status="Mystery"/>);
        expect(screen.getByText('Mystery')).toBeTruthy();
    });
});
