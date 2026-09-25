/**
 * Unit tests for the repo_sync worker handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

const findActiveConnection = vi.fn();
const decryptConnectionToken = vi.fn();
const outboundGet = vi.fn();
const updateConnection = vi.fn();
const hasActiveProjectWriterLock = vi.fn();
const findActiveJobForProjectByTypes = vi.fn();
const deferRunningJob = vi.fn();
const insertPendingJob = vi.fn();
const createPendingJob = vi.fn();
const inspectZip = vi.fn();
const storeAcceptedZipEntries = vi.fn();
const summarizeInspection = vi.fn();
const createArchiveFlowRewriter = vi.fn();
const insertSourceVersion = vi.fn();
const insertSourceFiles = vi.fn();
const setSourceVersionJobId = vi.fn();
const markGridFsFilesOrphaned = vi.fn();

function fakeArchiveFetch() {
  const buffer = Buffer.from('PK');
  return {
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) {
              return { done: true, value: undefined };
            }
            done = true;
            return { done: false, value: buffer };
          },
          async cancel() {},
        };
      },
    },
  };
}

vi.mock('../../../src/modules/knowledge/repositories.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findActiveConnection: (...args) => findActiveConnection(...args),
    decryptConnectionToken: (...args) => decryptConnectionToken(...args),
    updateConnection: (...args) => updateConnection(...args),
  };
});

vi.mock('../../../src/modules/knowledge/repositories.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    outboundGet: (...args) => outboundGet(...args),
  };
});

vi.mock('../../../src/worker/projectJobLock.js', () => ({
  hasActiveProjectWriterLock: (...args) => hasActiveProjectWriterLock(...args),
}));

vi.mock('../../../src/platform/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => ({
      repositories: {
        allowPrivateHosts: true,
        encryptionKey: 'test-key',
        keyId: 'test',
      },
    }),
  };
});

vi.mock('../../../src/modules/masters/index.js', () => ({
  findActiveJobForProjectByTypes: (...args) => findActiveJobForProjectByTypes(...args),
  deferRunningJob: (...args) => deferRunningJob(...args),
  insertPendingJob: (...args) => insertPendingJob(...args),
  createPendingJob: (...args) => createPendingJob(...args),
}));

vi.mock('../../../src/modules/knowledge/sources.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    insertSourceVersion: (...args) => insertSourceVersion(...args),
    insertSourceFiles: (...args) => insertSourceFiles(...args),
    setSourceVersionJobId: (...args) => setSourceVersionJobId(...args),
    markGridFsFilesOrphaned: (...args) => markGridFsFilesOrphaned(...args),
  };
});

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn(async () => ({
        withTransaction: async (fn) => fn(),
        endSession: async () => {},
      })),
    },
  };
});

vi.mock('../../../src/modules/knowledge/uploads.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    inspectZip: (...args) => inspectZip(...args),
    storeAcceptedZipEntries: (...args) => storeAcceptedZipEntries(...args),
    summarizeInspection: (...args) => summarizeInspection(...args),
    createArchiveRootRewriter: (...args) => createArchiveFlowRewriter(...args),
  };
});

const { runRepoSyncJob, repoSyncHandlerRegistration } = await import('../../../src/modules/knowledge/repoSync.js');

const TOKEN = 'ghp_handler_token_never_log';

/**
 * @returns {object}
 */
function connectionDoc() {
  return {
    _id: new mongoose.Types.ObjectId(),
    provider: 'github',
    baseUrl: null,
    repositoryFullName: 'acme/payments',
    selectedBranch: 'main',
    credentialId: new mongoose.Types.ObjectId(),
    lastSyncedCommitSha: 'oldsha',
  };
}

/**
 * @returns {{ job: object, recordEvent: Function, saveCheckpoint: Function, signal: AbortSignal }}
 */
function workerContext() {
  return {
    job: {
      _id: new mongoose.Types.ObjectId(),
      orgId: new mongoose.Types.ObjectId(),
      projectId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      correlationId: 'corr-1',
    },
    recordEvent: vi.fn(),
    saveCheckpoint: vi.fn(),
    signal: new AbortController().signal,
    log: { info: vi.fn(), error: vi.fn() },
  };
}

describe('runRepoSyncJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundGet.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => fakeArchiveFetch()));
    hasActiveProjectWriterLock.mockResolvedValue(false);
    findActiveJobForProjectByTypes.mockResolvedValue(null);
    createArchiveFlowRewriter.mockReturnValue((path) => path);
    summarizeInspection.mockImplementation((entries) => ({
      accepted: entries,
      skipped: [],
    }));
    storeAcceptedZipEntries.mockResolvedValue({ gridFsIds: [], files: [] });
    createPendingJob.mockResolvedValue({ jobId: 'job1' });
    insertSourceVersion.mockResolvedValue({});
    insertSourceFiles.mockResolvedValue({});
    setSourceVersionJobId.mockResolvedValue({});
  });

  it('registers exclusiveScope none', () => {
    expect(repoSyncHandlerRegistration).toMatchObject({
      type: 'repo_sync',
      exclusiveScope: 'none',
    });
  });

  it('defers when the project is busy', async () => {
    hasActiveProjectWriterLock.mockResolvedValue(true);
    const context = workerContext();
    const result = await runRepoSyncJob(context);
    expect(result.result).toBe('deferred');
    expect(deferRunningJob).toHaveBeenCalled();
    expect(context.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'repo.sync.deferred' }),
    );
    expect(outboundGet).not.toHaveBeenCalled();
  });

  it('completes with no_changes when the SHA matches', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    outboundGet.mockResolvedValue({
      status: 200,
      json: { sha: 'oldsha', commit: { message: null } },
    });
    const context = workerContext();
    const result = await runRepoSyncJob(context);
    expect(result.summary.outcome).toBe('no_changes');
    expect(inspectZip).not.toHaveBeenCalled();
    expect(JSON.stringify(context.log)).not.toContain(TOKEN);
    expect(context.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'repo.sync.no_changes',
        message: 'No changes on main',
      }),
    );
  });

  it('persists a new version and enqueues ingest on a new SHA', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    outboundGet
      .mockResolvedValueOnce({
        status: 200,
        json: { sha: 'newsha', commit: { message: null } },
      })
      .mockResolvedValueOnce({
        status: 200,
        buffer: Buffer.from('PK'),
        headers: { 'content-type': 'application/zip' },
      });
    inspectZip.mockResolvedValue({
      entries: [{ path: 'README.md', content: Buffer.from('hi') }],
    });
    storeAcceptedZipEntries.mockResolvedValue({ gridFsIds: [] });
    insertPendingJob.mockResolvedValue({
      job: { _id: 'job1' },
    });
    const result = await runRepoSyncJob(workerContext());
    expect(result.summary).toMatchObject({
      outcome: 'source_enqueued',
      commitSha: 'newsha',
    });
    expect(result.summary.ingestJobId).toBeDefined();
    expect(updateConnection).toHaveBeenCalled();
  });

  it('updates connectionStatus on auth failure and does not persist', async () => {
    findActiveConnection.mockResolvedValue(connectionDoc());
    decryptConnectionToken.mockResolvedValue(TOKEN);
    outboundGet.mockResolvedValue({ status: 401, json: {} });
    await expect(runRepoSyncJob(workerContext())).rejects.toMatchObject({
      code: 'token_invalid',
    });
    expect(inspectZip).not.toHaveBeenCalled();
    expect(updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          connectionStatus: 'authentication_required',
          lastSyncErrorCode: 'token_invalid',
        }),
      }),
    );
  });

  it('syncs a public repository without decrypting a credential', async () => {
    const connection = connectionDoc();
    connection.credentialId = null;
    connection.lastSyncedCommitSha = null;
    findActiveConnection.mockResolvedValue(connection);
    outboundGet
      .mockResolvedValueOnce({
        status: 200,
        json: { sha: 'newsha', commit: { message: null } },
      })
      .mockResolvedValueOnce({
        status: 200,
        buffer: Buffer.from('PK'),
        headers: { 'content-type': 'application/zip' },
      });
    inspectZip.mockResolvedValue({
      entries: [{ path: 'README.md', content: Buffer.from('hi') }],
    });
    storeAcceptedZipEntries.mockResolvedValue({ gridFsIds: [] });
    insertPendingJob.mockResolvedValue({ job: { _id: 'job2' } });
    const result = await runRepoSyncJob(workerContext());
    expect(decryptConnectionToken).not.toHaveBeenCalled();
    expect(result.summary.outcome).toBe('source_enqueued');
  });

  it('fails permanently when the connection is gone', async () => {
    findActiveConnection.mockResolvedValue(null);
    await expect(runRepoSyncJob(workerContext())).rejects.toMatchObject({
      failureClass: 'permanent',
      code: 'NOT_FOUND',
    });
  });
});
