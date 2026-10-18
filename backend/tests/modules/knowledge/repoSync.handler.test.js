/**
 * Unit tests for the connected_repo_pull worker handler.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const findLatestActiveSourceVersionForProject = vi.fn();
const enqueueSourceReingest = vi.fn();

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

vi.mock('../../../src/worker/projectLock.js', () => ({
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
    findLatestActiveSourceVersionForProject: (...args) => findLatestActiveSourceVersionForProject(...args),
    enqueueSourceReingest: (...args) => enqueueSourceReingest(...args),
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

const repoSync = await import('../../../src/modules/knowledge/repoSync.js');
const { runConnectedRepoPullJob, connectedRepoPullHandlerRegistration } = await import('../../../src/worker/connectedRepoPullJob.js');

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
    credential: {
      ciphertext: 'cipher',
      iv: 'iv',
      authTag: 'tag',
      keyId: 'k1',
      credentialKind: 'pat',
    },
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

describe('runConnectedRepoPullJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundGet.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeArchiveFetch()),
    );
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
    expect(connectedRepoPullHandlerRegistration).toMatchObject({
      type: 'connected_repo_pull',
      exclusiveScope: 'none',
    });
  });

  it('defers when the project is busy', async () => {
    hasActiveProjectWriterLock.mockResolvedValue(true);
    const context = workerContext();
    const result = await runConnectedRepoPullJob(context);
    expect(result.result).toBe('deferred');
    expect(deferRunningJob).toHaveBeenCalled();
    expect(context.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventCode: 'repo.sync.deferred' }));
    expect(outboundGet).not.toHaveBeenCalled();
  });

  it('completes with no_changes when the SHA matches for a scheduler job', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    vi.spyOn(repoSync, 'resolveRemoteHead').mockResolvedValue({ commitSha: 'oldsha', commitMessage: null });
    vi.spyOn(repoSync, 'markConnectionSynced').mockResolvedValue(undefined);
    const context = workerContext();
    context.job.createdBy = null;
    const result = await runConnectedRepoPullJob(context);
    expect(result.summary.outcome).toBe('no_changes');
    expect(inspectZip).not.toHaveBeenCalled();
    expect(enqueueSourceReingest).not.toHaveBeenCalled();
    expect(JSON.stringify(context.log)).not.toContain(TOKEN);
    expect(context.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'repo.sync.no_changes',
        message: 'No changes on main',
      }),
    );
  });

  it('enqueues a knowledge rebuild when manual sync finds the same SHA and a stored version', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    findLatestActiveSourceVersionForProject.mockResolvedValue({ _id: new mongoose.Types.ObjectId('665a00000000000000000011') });
    enqueueSourceReingest.mockResolvedValue({
      jobId: 'rebuild-job',
      sourceVersionId: '665a00000000000000000011',
      jobType: 'project_knowledge_rebuild',
    });
    vi.spyOn(repoSync, 'resolveRemoteHead').mockResolvedValue({ commitSha: 'oldsha', commitMessage: null });
    vi.spyOn(repoSync, 'markConnectionSynced').mockResolvedValue(undefined);
    const result = await runConnectedRepoPullJob(workerContext());
    expect(result.summary).toMatchObject({
      outcome: 'rebuild_enqueued',
      commitSha: 'oldsha',
      ingestJobId: 'rebuild-job',
    });
    expect(enqueueSourceReingest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceVersionId: '665a00000000000000000011',
      }),
    );
    expect(inspectZip).not.toHaveBeenCalled();
  });

  it('re-pulls when manual sync finds the same SHA but no stored version', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    findLatestActiveSourceVersionForProject.mockResolvedValue(null);
    vi.spyOn(repoSync, 'resolveRemoteHead').mockResolvedValue({ commitSha: 'oldsha', commitMessage: null });
    vi.spyOn(repoSync, 'downloadRepositoryArchive').mockResolvedValue({ archiveBuffer: Buffer.from('PK') });
    vi.spyOn(repoSync, 'persistRepositorySourceVersion').mockResolvedValue({
      sourceVersionId: 'sv-heal',
      ingestJobId: 'ij-heal',
    });
    vi.spyOn(repoSync, 'markConnectionSynced').mockResolvedValue(undefined);
    const result = await runConnectedRepoPullJob(workerContext());
    expect(result.summary).toMatchObject({
      outcome: 'source_enqueued',
      commitSha: 'oldsha',
      ingestJobId: 'ij-heal',
    });
    expect(enqueueSourceReingest).not.toHaveBeenCalled();
    expect(repoSync.persistRepositorySourceVersion).toHaveBeenCalled();
  });

  it('persists a new version and enqueues knowledge build on a new SHA', async () => {
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    vi.spyOn(repoSync, 'resolveRemoteHead').mockResolvedValue({ commitSha: 'newsha', commitMessage: null });
    vi.spyOn(repoSync, 'downloadRepositoryArchive').mockResolvedValue({ archiveBuffer: Buffer.from('PK') });
    vi.spyOn(repoSync, 'persistRepositorySourceVersion').mockResolvedValue({
      sourceVersionId: 'sv1',
      ingestJobId: 'ij1',
    });
    vi.spyOn(repoSync, 'markConnectionSynced').mockResolvedValue(undefined);
    const result = await runConnectedRepoPullJob(workerContext());
    expect(result.summary).toMatchObject({
      outcome: 'source_enqueued',
      commitSha: 'newsha',
      ingestJobId: 'ij1',
    });
    expect(repoSync.persistRepositorySourceVersion).toHaveBeenCalled();
  });

  it('updates connectionStatus on auth failure and does not persist', async () => {
    findActiveConnection.mockResolvedValue(connectionDoc());
    decryptConnectionToken.mockResolvedValue(TOKEN);
    vi.spyOn(repoSync, 'resolveRemoteHead').mockRejectedValue(
      Object.assign(new Error('token invalid'), {
        failureClass: 'user_action_required',
        code: 'token_invalid',
        probeStatus: 'authentication_required',
      }),
    );
    vi.spyOn(repoSync, 'markConnectionSyncFailed').mockResolvedValue(undefined);
    await expect(runConnectedRepoPullJob(workerContext())).rejects.toMatchObject({
      code: 'token_invalid',
    });
    expect(inspectZip).not.toHaveBeenCalled();
    expect(repoSync.markConnectionSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'token_invalid',
        probeStatus: 'authentication_required',
      }),
    );
  });

  it('syncs a public repository without decrypting a credential', async () => {
    const connection = connectionDoc();
    connection.credential = null;
    connection.lastSyncedCommitSha = null;
    findActiveConnection.mockResolvedValue(connection);
    vi.spyOn(repoSync, 'resolveRemoteHead').mockResolvedValue({ commitSha: 'newsha', commitMessage: null });
    vi.spyOn(repoSync, 'downloadRepositoryArchive').mockResolvedValue({ archiveBuffer: Buffer.from('PK') });
    vi.spyOn(repoSync, 'persistRepositorySourceVersion').mockResolvedValue({
      sourceVersionId: 'sv2',
      ingestJobId: 'ij2',
    });
    vi.spyOn(repoSync, 'markConnectionSynced').mockResolvedValue(undefined);
    const result = await runConnectedRepoPullJob(workerContext());
    expect(decryptConnectionToken).not.toHaveBeenCalled();
    expect(result.summary.outcome).toBe('source_enqueued');
  });

  it('fails permanently when the connection is gone', async () => {
    findActiveConnection.mockResolvedValue(null);
    await expect(runConnectedRepoPullJob(workerContext())).rejects.toMatchObject({
      failureClass: 'permanent',
      code: 'NOT_FOUND',
    });
  });
});
