/**
 * Pulls the latest commit from a connected GitHub/GitLab repo into a source version.
 */
import { findActiveConnection, decryptConnectionToken } from '../modules/knowledge/repositories.js';
import {
  deferRepoSyncJob,
  resolveRemoteHead,
  isProjectSyncBlocked,
  markConnectionSynced,
  markConnectionSyncFailed,
  downloadRepositoryArchive,
  REPO_SYNC_OVERLAP_RETRY_MS,
  persistRepositorySourceVersion,
} from '../modules/knowledge/repoSync.js';
import { enqueueSourceReingest, findLatestActiveSourceVersionForProject } from '../modules/knowledge/sources.js';

/**
 * Runs a claimed connected_repo_pull job.
 * @param {object} workerContext Handler context from the worker schedule.
 * @returns {Promise<{ result: string, summary?: object }>}
 */
export async function runConnectedRepoPullJob(workerContext) {
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
    if (connection.credential) {
      token = await decryptConnectionToken(connection.credential);
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
      const manualSync = Boolean(job.createdBy);
      if (manualSync) {
        const existingVersion = await findLatestActiveSourceVersionForProject({
          orgId,
          projectId,
          commitSha: head.commitSha,
        });
        if (existingVersion) {
          const rebuild = await enqueueSourceReingest({
            orgId,
            projectId,
            sourceVersionId: String(existingVersion._id),
            actorUserId: String(job.createdBy),
            correlationId: job.correlationId ?? null,
          });
          await markConnectionSynced({
            orgId,
            connectionId,
            commitSha: head.commitSha,
            jobId,
          });
          await workerContext.recordEvent({
            eventCode: 'repo.sync.rebuild_enqueued',
            severity: 'info',
            message: `No remote changes on ${connection.selectedBranch}; knowledge rebuild queued.`,
          });
          return {
            result: 'completed',
            summary: {
              outcome: 'rebuild_enqueued',
              commitSha: head.commitSha,
              sourceVersionId: rebuild.sourceVersionId,
              ingestJobId: rebuild.jobId,
            },
          };
        }
        // Manual sync with no stored version: fall through to download + persist (heal empty history).
      } else {
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
    const code = err && typeof err === 'object' && 'code' in err ? String(/** @type {{ code?: unknown }} */ (err).code) : 'provider_unavailable';
    const probeStatus =
      err && typeof err === 'object' && 'probeStatus' in err ? /** @type {{ probeStatus?: string | null }} */ (err).probeStatus : null;
    await markConnectionSyncFailed({
      orgId,
      connectionId,
      probeStatus,
      errorCode: code,
      jobId,
    });
    if (code === 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS') {
      const { markProjectKnowledgeFailed } = await import('../modules/knowledge/ingest.js');
      await markProjectKnowledgeFailed({
        orgId,
        projectId,
        sourceVersionId: null,
        failureCode: code,
        correlationId: job.correlationId ?? null,
        log: workerContext.log,
      });
    }
    throw err;
  }
}

/** Registration for jobType connected_repo_pull. */
export const connectedRepoPullHandlerRegistration = {
  type: 'connected_repo_pull',
  exclusiveScope: /** @type {'none'} */ ('none'),
  run: runConnectedRepoPullJob,
};
