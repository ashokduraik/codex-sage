/**
 * Unit tests for the repo_sync due-connection scanner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

const insertPendingJob = vi.fn();
const findActiveJobForProjectByTypes = vi.fn();
const updateConnection = vi.fn();
const hasActiveProjectWriterLock = vi.fn();

vi.mock('../../../src/modules/masters/index.js', () => ({
  insertPendingJob: (...args) => insertPendingJob(...args),
  findActiveJobForProjectByTypes: (...args) => findActiveJobForProjectByTypes(...args),
  createPendingJob: vi.fn(),
  deferRunningJob: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/repositories.js', () => ({
  listDueConnections: vi.fn(),
  updateConnection: (...args) => updateConnection(...args),
  findActiveConnection: vi.fn(),
  decryptConnectionToken: vi.fn(),
}));

vi.mock('../../../src/worker/projectJobLock.js', () => ({
  hasActiveProjectWriterLock: (...args) => hasActiveProjectWriterLock(...args),
}));

const { enqueueDueRepositorySyncs } = await import('../../../src/modules/knowledge/repoSync.js');

describe('enqueueDueRepositorySyncs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues due connections and skips overlap', async () => {
    const due = [
      {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
      },
    ];
    findActiveJobForProjectByTypes.mockResolvedValue(null);
    hasActiveProjectWriterLock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    insertPendingJob.mockResolvedValue({ job: { _id: new mongoose.Types.ObjectId() } });

    const result = await enqueueDueRepositorySyncs({
      now: new Date('2026-09-23T00:00:00.000Z'),
      listDue: async () => due,
      log: { info: vi.fn(), error: vi.fn() },
    });
    expect(result).toEqual({ enqueued: 1, skipped: 1 });
    expect(insertPendingJob).toHaveBeenCalledOnce();
    expect(updateConnection).toHaveBeenCalledOnce();
  });

  it('skips when a repo_sync job is already active', async () => {
    findActiveJobForProjectByTypes.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    const result = await enqueueDueRepositorySyncs({
      listDue: async () => [
        {
          _id: new mongoose.Types.ObjectId(),
          orgId: new mongoose.Types.ObjectId(),
          projectId: new mongoose.Types.ObjectId(),
        },
      ],
    });
    expect(result.skipped).toBe(1);
    expect(insertPendingJob).not.toHaveBeenCalled();
  });

  it('counts a connection as skipped when enqueue throws', async () => {
    findActiveJobForProjectByTypes.mockResolvedValue(null);
    hasActiveProjectWriterLock.mockResolvedValue(false);
    insertPendingJob.mockRejectedValue(new Error('write failed'));
    const log = { error: vi.fn(), info: vi.fn() };
    const result = await enqueueDueRepositorySyncs({
      listDue: async () => [
        {
          _id: new mongoose.Types.ObjectId(),
          orgId: new mongoose.Types.ObjectId(),
          projectId: new mongoose.Types.ObjectId(),
        },
      ],
      log,
    });
    expect(result.skipped).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });
});
