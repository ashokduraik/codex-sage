import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import ProcessingIndicator from './ProcessingIndicator';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
describe('ProcessingIndicator', () => {
    it('returns null when there is no job', () => {
        const { container } = renderWithProviders(<ProcessingIndicator job={null} project={null}/>);
        expect(container.textContent).toBe('');
    });
    it('renders job progress when a job is active', () => {
        const job = {
            id: 'job1',
            projectId: 'p1',
            op: 'Initial processing',
            status: 'in_progress',
            progress: 42,
            startedAt: new Date().toISOString(),
            stages: [],
            activity: [],
            warnings: [],
            errors: [],
        };
        const project = { id: 'p1', name: 'Atlas' };
        renderWithProviders(<ProcessingIndicator job={job} project={project}/>);
        expect(screen.getByText(/Initial processing/)).toBeTruthy();
        expect(screen.getAllByText(/42%/).length).toBeGreaterThan(0);
    });
});
