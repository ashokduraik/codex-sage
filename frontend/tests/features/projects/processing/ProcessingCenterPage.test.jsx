import { ApiError } from '@/shared/api/index';
import { buildJobDetail, buildListJob } from './test/jobFixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ProcessingCenterPage from '@/features/projects/processing/ProcessingCenterPage';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

const listProjectJobs = vi.fn();
const getJob = vi.fn();
const retryJob = vi.fn();
const cancelJob = vi.fn();

vi.mock('@/features/projects/processing/api/jobsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listProjectJobs: (...args) => listProjectJobs(...args),
    getJob: (...args) => getJob(...args),
    retryJob: (...args) => retryJob(...args),
    cancelJob: (...args) => cancelJob(...args),
  };
});

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  listProjectJobs.mockReset();
  getJob.mockReset();
  retryJob.mockReset();
  cancelJob.mockReset();
});

describe('ProcessingCenterPage', () => {
  it('asks the user to select a project when none is in context', () => {
    renderWithProviders(<ProcessingCenterPage />, { route: '/processing' });
    expect(screen.getByText('Select a project')).toBeTruthy();
    expect(listProjectJobs).not.toHaveBeenCalled();
  });

  it('shows a running job stage list and no percent bar when percent is null', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob()],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(buildJobDetail());
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('In progress')).toBeTruthy();
    expect(await screen.findByText('Project structure analyzed')).toBeTruthy();
    expect(screen.getByText('Source received')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows retry when available and hides it when not', async () => {
    const failed = buildListJob({
      id: 'job_failed',
      jobStatus: 'failed',
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [failed],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...failed,
        jobStatus: 'failed',
        retry: { available: true, mode: 'resume', reason: null },
        stages: [],
        errors: [{ code: 'E1', message: 'Index failed', affectedCount: 3 }],
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry.disabled).toBe(false);
    fireEvent.click(screen.getByText('Show errors'));
    expect(screen.getByText(/Index failed/)).toBeTruthy();
    expect(screen.getByText(/3 affected/)).toBeTruthy();
  });

  it('toggles activity messages from events', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob()],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(buildJobDetail());
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    fireEvent.click(await screen.findByText('Show activity log'));
    expect(screen.getByText('Processing is queued.')).toBeTruthy();
  });

  it('retries with an Idempotency-Key', async () => {
    const failed = buildListJob({
      id: 'job_failed',
      jobStatus: 'failed',
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [failed],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...failed,
        jobStatus: 'failed',
        retry: { available: true, mode: 'full', reason: null },
        stages: [],
      }),
    );
    retryJob.mockResolvedValue({ jobId: 'job_failed', jobStatus: 'retrying' });
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(retryJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job_failed',
          idempotencyKey: expect.any(String),
        }),
      );
    });
  });

  it('shows a 409 alert when retry is rejected', async () => {
    const failed = buildListJob({
      id: 'job_failed',
      jobStatus: 'failed',
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [failed],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...failed,
        jobStatus: 'failed',
        retry: { available: true, mode: 'full', reason: null },
        stages: [],
      }),
    );
    retryJob.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'INVALID_JOB_TRANSITION',
        message: 'Job cannot be retried.',
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Job cannot be retried.')).toBeTruthy();
  });

  it('refetches the list after a failure', async () => {
    listProjectJobs.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' }));
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('boom')).toBeTruthy();
    listProjectJobs.mockResolvedValue({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No processing activity')).toBeTruthy();
  });

  it('uses API counts for partial success copy', async () => {
    const partial = buildListJob({
      id: 'job_partial',
      jobStatus: 'completed_with_warnings',
      partialSuccess: true,
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [partial],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...partial,
        jobStatus: 'completed_with_warnings',
        itemsProcessed: 4812,
        itemsFailed: 9,
        stages: [],
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText(/4,812 files processed successfully/)).toBeTruthy();
    expect(screen.getByText(/9 files failed/)).toBeTruthy();
  });

  it('renders a percent bar only when the backend sends percent', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob()],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(buildJobDetail({ percent: 40 }));
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('40%')).toBeTruthy();
  });

  it('shows a disabled retry with reason when the job is not retryable', async () => {
    const failed = buildListJob({
      id: 'job_failed',
      jobStatus: 'failed',
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [failed],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...failed,
        jobStatus: 'failed',
        retry: { available: false, mode: null, reason: 'not_retryable' },
        stages: [],
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('title')).toBe('not_retryable');
  });

  it('confirms cancel and shows cancellation requested copy', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob({ cancellation: { requested: false } })],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(buildJobDetail());
    cancelJob.mockResolvedValue({
      jobId: 'job_active',
      jobStatus: 'running',
      cancellation: { requested: true, requestedAt: '2026-01-02T00:02:00.000Z' },
    });
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cancel this job?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop processing' }));
    await waitFor(() => {
      expect(cancelJob).toHaveBeenCalledWith({ jobId: 'job_active' });
    });
  });

  it('shows cancellation requested when the API already flagged it', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob()],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        cancellation: { requested: true, requestedAt: '2026-01-02T00:02:00.000Z' },
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText(/Cancellation requested/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows warnings and completion CTAs when the project is askable', async () => {
    const done = buildListJob({
      id: 'job_done',
      jobStatus: 'completed',
      completedAt: '2026-01-02T00:10:00.000Z',
    });
    listProjectJobs.mockResolvedValue({
      items: [done],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockResolvedValue(
      buildJobDetail({
        ...done,
        jobStatus: 'completed',
        warnings: [{ code: 'W1', message: 'Skipped vendor files', affectedCount: 2 }],
        stages: [],
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('Skipped vendor files')).toBeTruthy();
    expect(screen.getByText('Your project is ready to explore.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open chat/i })).toBeTruthy();
  });

  it('shows a detail error with correlation id', async () => {
    listProjectJobs.mockResolvedValue({
      items: [buildListJob()],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    getJob.mockRejectedValue(
      new ApiError({
        status: 404,
        code: 'JOB_NOT_FOUND',
        message: 'Job missing',
        correlationId: 'corr-job',
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('Job missing')).toBeTruthy();
    expect(screen.getByText(/corr-job/)).toBeTruthy();
  });

  it('loads the next history page', async () => {
    listProjectJobs
      .mockResolvedValueOnce({
        items: [
          buildListJob({
            id: 'job_old',
            jobStatus: 'completed',
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        pageInfo: { nextCursor: 'next-1', hasMore: true },
      })
      .mockResolvedValueOnce({
        items: [
          buildListJob({
            id: 'job_older',
            jobStatus: 'failed',
            completedAt: '2025-12-01T00:00:00.000Z',
          }),
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    getJob.mockImplementation(async (id) =>
      buildJobDetail({
        id,
        jobStatus: id === 'job_old' ? 'completed' : 'failed',
        stages: [],
      }),
    );
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(listProjectJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('falls back when the list error is not an ApiError', async () => {
    listProjectJobs.mockRejectedValue(new Error('network down'));
    renderWithProviders(<ProcessingCenterPage />, {
      route: '/processing?projectId=prj_atlas',
    });
    expect(await screen.findByText('network down')).toBeTruthy();
  });
});
