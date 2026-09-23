/**
 * Worker handler for `repo_sync` — fetch HEAD, persist on new SHA, enqueue ingest.
 */
import { findActiveConnection } from '../repositories.repository.js';
import { decryptConnectionToken } from '../repositoryCredential.service.js';
import {
  downloadRepositoryArchive,
  resolveRemoteHead,
} from './archiveSyncAdapter.js';
import { REPO_SYNC_OVERLAP_RETRY_MS } from './repoSync.constants.js';
import {
  deferRepoSyncJob,
  isProjectSyncBlocked,
  markConnectionSyncFailed,
  markConnectionSynced,
  persistRepositorySourceVersion,
} from './repoSync.service.js';

/**
 * Runs one claimed `repo_sync` job.
 * @param {object} workerContext Worker-provided context.
 * @returns {Promise<{ result: 'completed' | 'deferred', summary?: object }>}
 */
export async function runRepoSyncJob(workerContext) {
  const job = workerContext.job;
  const orgId = String(job.orgId);
  const projectId = String(job.projectId);
  const jobId = String(job._id);

  const blocked = await isProjectSyncBlocked({
    orgId,
    projectId,
    excludeJobId: jobId,
  });
  if (blocked) {
    await deferRepoSyncJob({ jobId, orgId, delayMs: REPO_SYNC_OVERLAP_RETRY_MS });
    await workerContext.recordEvent({
      eventCode: 'repo.sync.deferred',
      severity: 'info',
      message: 'Sync deferred because the project is busy.',
    });
    return { result: 'deferred' };
  }

  const connection = await findActiveConnection(orgId, projectId);
  if (!connection) {
    throw Object.assign(new Error('Repository connection was not found.'), {
      failureClass: 'permanent',
      code: 'NOT_FOUND',
      probeStatus: null,
    });
  }

  const connectionId = String(connection._id);
  await workerContext.saveCheckpoint({
    lastCompletedStage: 'fetch_remote',
    currentStage: 'fetch_remote',
  });

  let token = null;
  try {
    if (connection.credentialId) {
      token = await decryptConnectionToken({
        orgId,
        projectId,
        credentialId: String(connection.credentialId),
      });
    }

    const head = await resolveRemoteHead({
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      fullName: connection.repositoryFullName,
      branch: connection.selectedBranch,
      token,
      signal: workerContext.signal,
    });

    if (head.commitSha === connection.lastSyncedCommitSha) {
      await markConnectionSynced({
        orgId,
        connectionId,
        commitSha: head.commitSha,
        jobId,
      });
      await workerContext.recordEvent({
        eventCode: 'repo.sync.no_changes',
        severity: 'info',
        message: `No changes on ${connection.selectedBranch}`,
      });
      return {
        result: 'completed',
        summary: { outcome: 'no_changes', commitSha: head.commitSha },
      };
    }

    await workerContext.saveCheckpoint({
      lastCompletedStage: 'persist_source',
      currentStage: 'persist_source',
    });

    const { archiveBuffer } = await downloadRepositoryArchive({
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      fullName: connection.repositoryFullName,
      branch: connection.selectedBranch,
      commitSha: head.commitSha,
      token,
      signal: workerContext.signal,
    });

    const persisted = await persistRepositorySourceVersion({
      orgId,
      projectId,
      connectionId,
      branch: connection.selectedBranch,
      commitSha: head.commitSha,
      archiveBuffer,
      actorUserId: job.createdBy ? String(job.createdBy) : null,
      correlationId: job.correlationId ?? null,
    });

    await workerContext.saveCheckpoint({
      lastCompletedStage: 'enqueue_ingest',
      currentStage: 'enqueue_ingest',
    });

    await markConnectionSynced({
      orgId,
      connectionId,
      commitSha: head.commitSha,
      jobId,
    });
    await workerContext.recordEvent({
      eventCode: 'repo.sync.source_enqueued',
      severity: 'info',
      message: 'Source queued for processing.',
    });

    return {
      result: 'completed',
      summary: {
        outcome: 'source_enqueued',
        commitSha: head.commitSha,
        sourceVersionId: persisted.sourceVersionId,
        ingestJobId: persisted.ingestJobId,
      },
    };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String(/** @type {{ code?: unknown }} */ (err).code)
        : 'provider_unavailable';
    const probeStatus =
      err && typeof err === 'object' && 'probeStatus' in err
        ? /** @type {{ probeStatus?: string | null }} */ (err).probeStatus
        : null;
    await markConnectionSyncFailed({
      orgId,
      connectionId,
      probeStatus,
      errorCode: code,
      jobId,
    });
    throw err;
  } finally {
    token = null;
  }
}

/**
 * Registration descriptor for the repo_sync handler.
 */
export const repoSyncHandlerRegistration = {
  type: 'repo_sync',
  exclusiveScope: /** @type {'none'} */ ('none'),
  run: runRepoSyncJob,
};
