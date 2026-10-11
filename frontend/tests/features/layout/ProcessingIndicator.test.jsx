import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ProcessingIndicator from '@/features/layout/ProcessingIndicator';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

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
    const { container } = renderWithProviders(<ProcessingIndicator job={null} project={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders the stage label without a percent', () => {
    const job = {
      id: 'job1',
      projectId: 'p1',
      jobType: 'ingest',
      jobStatus: 'running',
      currentStage: 'codegraph_update',
    };
    const project = { id: 'p1', name: 'Atlas' };
    const { container } = renderWithProviders(<ProcessingIndicator job={job} project={project} />);
    expect(screen.getByText(/Project structure analyzed · Atlas/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/%/);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/processing?projectId=p1');
  });

  it('falls back to the job type and /processing when project context is missing', () => {
    const job = {
      id: 'job1',
      jobType: 'ingest',
      jobStatus: 'running',
      currentStage: null,
    };
    renderWithProviders(<ProcessingIndicator job={job} project={null} />);
    expect(screen.getByText(/Knowledge update · project/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/processing');
  });
});
