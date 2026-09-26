/**
 * Unit tests for jobs API mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn();

vi.mock('@/shared/api/index', () => ({
  apiRequest: (...args) => apiRequest(...args),
}));

import {
  cancelJob,
  getJob,
  JOB_LIST_PAGE_SIZE,
  jobDetailQueryKey,
  listProjectJobs,
  projectJobsQueryKey,
  projectJobsQueryRoot,
  retryJob,
} from '@/features/projects/processing/api/jobsApi.js';

describe('jobsApi', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('lists project jobs with default page size', async () => {
    apiRequest.mockResolvedValue({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
    await listProjectJobs({ projectId: 'p1' });
    expect(apiRequest).toHaveBeenCalledWith(`/projects/p1/jobs?limit=${JOB_LIST_PAGE_SIZE}`, {
      signal: undefined,
    });
  });

  it('lists project jobs with cursor and jobStatus', async () => {
    apiRequest.mockResolvedValue({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
    await listProjectJobs({
      projectId: 'p1',
      cursor: 'abc',
      limit: 10,
      jobStatus: 'failed',
      signal: undefined,
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/jobs?cursor=abc&limit=10&jobStatus=failed', { signal: undefined });
  });

  it('gets job detail', async () => {
    apiRequest.mockResolvedValue({ id: 'j1' });
    await getJob('j1', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/jobs/j1', { signal: undefined });
  });

  it('retries with Idempotency-Key', async () => {
    apiRequest.mockResolvedValue({ jobId: 'j1', jobStatus: 'retrying' });
    await retryJob({ jobId: 'j1', idempotencyKey: 'idem-1' });
    expect(apiRequest).toHaveBeenCalledWith('/jobs/j1/retry', {
      method: 'POST',
      idempotencyKey: 'idem-1',
      signal: undefined,
    });
  });

  it('cancels without an idempotency key', async () => {
    apiRequest.mockResolvedValue({ jobId: 'j1', jobStatus: 'running' });
    await cancelJob({ jobId: 'j1' });
    expect(apiRequest).toHaveBeenCalledWith('/jobs/j1/cancel', {
      method: 'POST',
      signal: undefined,
    });
  });

  it('exposes query keys used by upload invalidation', () => {
    expect(projectJobsQueryRoot('p1')).toEqual(['projects', 'p1', 'jobs']);
    expect(projectJobsQueryKey('p1')).toEqual(['projects', 'p1', 'jobs', { jobStatus: null }]);
    expect(jobDetailQueryKey('j1')).toEqual(['jobs', 'detail', 'j1']);
  });
});
