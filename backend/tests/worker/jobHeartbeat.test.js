/**
 * Unit tests for refreshJobLease / heartbeatInFlightJob with mocked Job updates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateOneExec = vi.fn();
const updateOne = vi.fn(() => ({ exec: updateOneExec }));

vi.mock('../../src/models/job.model.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Job: { ...actual.Job, updateOne },
  };
});

vi.mock('../../src/worker/projectLock.js', () => ({
  refreshProjectJobLock: vi.fn().mockResolvedValue(true),
}));

describe('jobHeartbeat', () => {
  beforeEach(() => {
    updateOne.mockClear();
    updateOneExec.mockReset();
  });

  it('returns owned false when the workerId condition matches nothing', async () => {
    updateOneExec.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const { heartbeatInFlightJob } = await import('../../src/worker/schedule.js');
    const { refreshProjectJobLock } = await import('../../src/worker/projectLock.js');

    const result = await heartbeatInFlightJob({
      jobId: '665f1c9d4b2a8e0012a4f001',
      workerId: 'worker-a',
      orgId: '6650aa1b4b2a8e0012a4e001',
      projectId: '6651bb2c4b2a8e0012a4e002',
      holdsProjectLock: true,
    });

    expect(result).toEqual({ owned: false });
    expect(refreshProjectJobLock).not.toHaveBeenCalled();
  });

  it('refreshes the project lock when the lease update matches', async () => {
    updateOneExec.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const { heartbeatInFlightJob } = await import('../../src/worker/schedule.js');
    const { refreshProjectJobLock } = await import('../../src/worker/projectLock.js');
    /** @type {import('vitest').Mock} */ (refreshProjectJobLock).mockClear();

    const result = await heartbeatInFlightJob({
      jobId: '665f1c9d4b2a8e0012a4f001',
      workerId: 'worker-a',
      orgId: '6650aa1b4b2a8e0012a4e001',
      projectId: '6651bb2c4b2a8e0012a4e002',
      holdsProjectLock: true,
    });

    expect(result).toEqual({ owned: true });
    expect(refreshProjectJobLock).toHaveBeenCalledOnce();
  });
});
