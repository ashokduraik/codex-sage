/**
 * Lease sweeper error and fail-path coverage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findAggregate = vi.fn();
const requeueJobInterrupted = vi.fn();
const failJobLeaseExpired = vi.fn();
const releaseProjectJobLock = vi.fn();

vi.mock('../../src/models/job.model.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Job: {
      ...actual.Job,
      aggregate: (...args) => findAggregate(...args),
    },
  };
});

vi.mock('../../src/worker/jobState.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    requeueJobInterrupted: (...args) => requeueJobInterrupted(...args),
    failJobLeaseExpired: (...args) => failJobLeaseExpired(...args),
  };
});

vi.mock('../../src/worker/projectLock.js', () => ({
  releaseProjectJobLock: (...args) => releaseProjectJobLock(...args),
}));

describe('leaseSweeper', () => {
  beforeEach(() => {
    findAggregate.mockReset();
    requeueJobInterrupted.mockReset();
    failJobLeaseExpired.mockReset();
    releaseProjectJobLock.mockReset().mockResolvedValue(true);
  });

  it('logs and continues when a single job sweep throws', async () => {
    findAggregate.mockResolvedValue([
      {
        _id: '665f1c9d4b2a8e0012a4f099',
        orgId: '6650aa1b4b2a8e0012a4e099',
        projectId: '6651bb2c4b2a8e0012a4e099',
        attempt: 1,
        maxAttempts: 5,
      },
    ]);
    requeueJobInterrupted.mockRejectedValueOnce(new Error('requeue boom'));
    const { sweepExpiredLeases } = await import('../../src/worker/schedule.js');
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await sweepExpiredLeases({ log });
    expect(result).toEqual({ requeued: 0, failed: 0 });
    expect(log.error).toHaveBeenCalled();
  });

  it('fails exhausted attempts and releases the lock', async () => {
    findAggregate.mockResolvedValue([
      {
        _id: '665f1c9d4b2a8e0012a4f098',
        orgId: '6650aa1b4b2a8e0012a4e098',
        projectId: '6651bb2c4b2a8e0012a4e098',
        attempt: 5,
        maxAttempts: 5,
      },
    ]);
    failJobLeaseExpired.mockResolvedValue({
      _id: '665f1c9d4b2a8e0012a4f098',
      orgId: '6650aa1b4b2a8e0012a4e098',
      projectId: '6651bb2c4b2a8e0012a4e098',
      attempt: 5,
    });
    const { sweepExpiredLeases } = await import('../../src/worker/schedule.js');
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await sweepExpiredLeases({ log });
    expect(result.failed).toBe(1);
    expect(releaseProjectJobLock).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('uses default maxAttempts when missing on the job row', async () => {
    findAggregate.mockResolvedValue([
      {
        _id: '665f1c9d4b2a8e0012a4f097',
        orgId: '6650aa1b4b2a8e0012a4e097',
        projectId: '6651bb2c4b2a8e0012a4e097',
        attempt: 1,
      },
    ]);
    requeueJobInterrupted.mockResolvedValue({
      _id: '665f1c9d4b2a8e0012a4f097',
      orgId: '6650aa1b4b2a8e0012a4e097',
      projectId: '6651bb2c4b2a8e0012a4e097',
      attempt: 1,
    });
    const { sweepExpiredLeases } = await import('../../src/worker/schedule.js');
    const result = await sweepExpiredLeases({ log: { info: vi.fn(), error: vi.fn() } });
    expect(result.requeued).toBe(1);
  });
});
