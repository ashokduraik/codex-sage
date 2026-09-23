/**
 * Unit tests for the repo_sync worker handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

const findActiveConnection = vi.fn();
const decryptConnectionToken = vi.fn();
const resolveRemoteHead = vi.fn();
const downloadRepositoryArchive = vi.fn();
const isProjectSyncBlocked = vi.fn();
const deferRepoSyncJob = vi.fn();
const markConnectionSynced = vi.fn();
const markConnectionSyncFailed = vi.fn();
const persistRepositorySourceVersion = vi.fn();

vi.mock('../repositories.repository.js', () => ({
  findActiveConnection: (...args) => findActiveConnection(...args),
  updateConnection: vi.fn(),
  listDueConnections: vi.fn(),
}));

vi.mock('../repositoryCredential.service.js', () => ({
  decryptConnectionToken: (...args) => decryptConnectionToken(...args),
}));

vi.mock('./archiveSyncAdapter.js', () => ({
  resolveRemoteHead: (...args) => resolveRemoteHead(...args),
  downloadRepositoryArchive: (...args) => downloadRepositoryArchive(...args),
}));

vi.mock('./repoSync.service.js', () => ({
  isProjectSyncBlocked: (...args) => isProjectSyncBlocked(...args),
  deferRepoSyncJob: (...args) => deferRepoSyncJob(...args),
  markConnectionSynced: (...args) => markConnectionSynced(...args),
  markConnectionSyncFailed: (...args) => markConnectionSyncFailed(...args),
  persistRepositorySourceVersion: (...args) => persistRepositorySourceVersion(...args),
}));

const { runRepoSyncJob, repoSyncHandlerRegistration } = await import('./repoSync.handler.js');

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
  });

  it('registers exclusiveScope none', () => {
    expect(repoSyncHandlerRegistration).toMatchObject({
      type: 'repo_sync',
      exclusiveScope: 'none',
    });
  });

  it('defers when the project is busy', async () => {
    isProjectSyncBlocked.mockResolvedValue(true);
    const context = workerContext();
    const result = await runRepoSyncJob(context);
    expect(result.result).toBe('deferred');
    expect(deferRepoSyncJob).toHaveBeenCalled();
    expect(context.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'repo.sync.deferred' }),
    );
    expect(resolveRemoteHead).not.toHaveBeenCalled();
  });

  it('completes with no_changes when the SHA matches', async () => {
    isProjectSyncBlocked.mockResolvedValue(false);
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    resolveRemoteHead.mockResolvedValue({ commitSha: 'oldsha', commitMessage: null });
    const context = workerContext();
    const result = await runRepoSyncJob(context);
    expect(result.summary.outcome).toBe('no_changes');
    expect(downloadRepositoryArchive).not.toHaveBeenCalled();
    expect(persistRepositorySourceVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(context.log)).not.toContain(TOKEN);
    expect(context.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'repo.sync.no_changes',
        message: 'No changes on main',
      }),
    );
  });

  it('persists a new version and enqueues ingest on a new SHA', async () => {
    isProjectSyncBlocked.mockResolvedValue(false);
    const connection = connectionDoc();
    findActiveConnection.mockResolvedValue(connection);
    decryptConnectionToken.mockResolvedValue(TOKEN);
    resolveRemoteHead.mockResolvedValue({ commitSha: 'newsha', commitMessage: null });
    downloadRepositoryArchive.mockResolvedValue({ archiveBuffer: Buffer.from('PK') });
    persistRepositorySourceVersion.mockResolvedValue({
      sourceVersionId: 'sv1',
      ingestJobId: 'job1',
    });
    const result = await runRepoSyncJob(workerContext());
    expect(result.summary).toMatchObject({
      outcome: 'source_enqueued',
      commitSha: 'newsha',
      sourceVersionId: 'sv1',
      ingestJobId: 'job1',
    });
    expect(markConnectionSynced).toHaveBeenCalled();
  });

  it('updates connectionStatus on auth failure and does not persist', async () => {
    isProjectSyncBlocked.mockResolvedValue(false);
    findActiveConnection.mockResolvedValue(connectionDoc());
    decryptConnectionToken.mockResolvedValue(TOKEN);
    resolveRemoteHead.mockRejectedValue(
      Object.assign(new Error('The access token was rejected. Check the token and try again.'), {
        failureClass: 'user_action_required',
        code: 'token_invalid',
        probeStatus: 'authentication_required',
      }),
    );
    await expect(runRepoSyncJob(workerContext())).rejects.toMatchObject({
      code: 'token_invalid',
    });
    expect(persistRepositorySourceVersion).not.toHaveBeenCalled();
    expect(markConnectionSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        probeStatus: 'authentication_required',
        errorCode: 'token_invalid',
      }),
    );
  });

  it('syncs a public repository without decrypting a credential', async () => {
    isProjectSyncBlocked.mockResolvedValue(false);
    const connection = connectionDoc();
    connection.credentialId = null;
    connection.lastSyncedCommitSha = null;
    findActiveConnection.mockResolvedValue(connection);
    resolveRemoteHead.mockResolvedValue({ commitSha: 'newsha', commitMessage: null });
    downloadRepositoryArchive.mockResolvedValue({ archiveBuffer: Buffer.from('PK') });
    persistRepositorySourceVersion.mockResolvedValue({
      sourceVersionId: 'sv2',
      ingestJobId: 'job2',
    });
    const result = await runRepoSyncJob(workerContext());
    expect(decryptConnectionToken).not.toHaveBeenCalled();
    expect(result.summary.outcome).toBe('source_enqueued');
  });

  it('fails permanently when the connection is gone', async () => {
    isProjectSyncBlocked.mockResolvedValue(false);
    findActiveConnection.mockResolvedValue(null);
    await expect(runRepoSyncJob(workerContext())).rejects.toMatchObject({
      failureClass: 'permanent',
      code: 'NOT_FOUND',
    });
  });
});
