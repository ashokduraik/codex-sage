/**
 * Unit tests for the repo_sync due-connection scanner.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertPendingJob = vi.fn();
const findActiveJobForProjectByTypes = vi.fn();
const updateConnection = vi.fn();
const hasActiveProjectWriterLock = vi.fn();
const listDueConnections = vi.fn();

vi.mock('../../../src/modules/masters/index.js', () => ({
  insertPendingJob: (...args) => insertPendingJob(...args),
  findActiveJobForProjectByTypes: (...args) => findActiveJobForProjectByTypes(...args),
  createPendingJob: vi.fn(),
  deferRunningJob: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/repositories.js', () => ({
  listDueConnections: (...args) => listDueConnections(...args),
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
    listDueConnections.mockResolvedValue(due);
    findActiveJobForProjectByTypes.mockResolvedValue(null);
    hasActiveProjectWriterLock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    insertPendingJob.mockResolvedValue({ job: { _id: new mongoose.Types.ObjectId() } });

    const result = await enqueueDueRepositorySyncs({
      log: { info: vi.fn(), error: vi.fn() },
    });
    expect(result).toEqual({ enqueued: 1, skipped: 1 });
    expect(insertPendingJob).toHaveBeenCalledOnce();
    expect(updateConnection).toHaveBeenCalledOnce();
    expect(listDueConnections).toHaveBeenCalledOnce();
  });

  it('skips when a repo_sync job is already active', async () => {
    findActiveJobForProjectByTypes.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    listDueConnections.mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
      },
    ]);
    const result = await enqueueDueRepositorySyncs();
    expect(result.skipped).toBe(1);
    expect(insertPendingJob).not.toHaveBeenCalled();
  });

  it('counts a connection as skipped when enqueue throws', async () => {
    findActiveJobForProjectByTypes.mockResolvedValue(null);
    hasActiveProjectWriterLock.mockResolvedValue(false);
    insertPendingJob.mockRejectedValue(new Error('write failed'));
    const log = { error: vi.fn(), info: vi.fn() };
    listDueConnections.mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
      },
    ]);
    const result = await enqueueDueRepositorySyncs({
      log,
    });
    expect(result.skipped).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });
});
