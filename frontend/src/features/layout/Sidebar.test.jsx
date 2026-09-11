import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import Sidebar from './Sidebar';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('Sidebar', () => {
    it('renders nav labels and can collapse to icon mode', () => {
        const onToggle = vi.fn();
        renderWithProviders(<Sidebar collapsed={false} onToggle={onToggle}/>);
        expect(screen.getByText('Home')).toBeTruthy();
        expect(screen.getByText('Codex Sage')).toBeTruthy();
        expect(screen.getByText('Collapse')).toBeTruthy();
        fireEvent.click(screen.getByText('Collapse'));
        expect(onToggle).toHaveBeenCalled();
        cleanup();
        clearAuthSession();
        localStorage.clear();
        seedAuthSession();
        renderWithProviders(<Sidebar collapsed={true} onToggle={onToggle}/>);
        expect(screen.queryByText('Collapse')).toBeNull();
        expect(screen.getByLabelText('Expand')).toBeTruthy();
    });
    it('shows the current project when path matches a project', () => {
        renderWithProviders(<Sidebar collapsed={false} onToggle={() => undefined}/>, { route: '/projects/prj_atlas' });
        expect(screen.getByText('Current project')).toBeTruthy();
        expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
    });
});
