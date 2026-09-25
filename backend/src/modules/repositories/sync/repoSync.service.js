/**
 * Repository sync orchestration: enqueue, persist archive, and connection updates.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../../platform/errors.js';
import { recordAuditEvent } from '../../audit/index.js';
import {
  createPendingJob,
  deferRunningJob,
  findActiveJobForProjectByTypes,
  insertPendingJob,
} from '../../jobs/index.js';
import {
  SOURCE_ORIGIN_REPOSITORY,
  inspectZip,
  insertSourceFiles,
  insertSourceVersion,
  markGridFsFilesOrphaned,
  setSourceVersionJobId,
  storeAcceptedZipEntries,
  summarizeInspection,
} from '../../sources/index.js';
import { hasActiveProjectWriterLock } from '../../../worker/projectJobLock.js';
import { findActiveConnection, updateConnection } from '../repositories.repository.js';
import {
  REPO_SYNC_INTERVAL_MS,
  REPO_SYNC_OVERLAP_JOB_TYPES,
  REPO_SYNC_OVERLAP_RETRY_MS,
} from './repoSync.constants.js';

/**
 * Builds a rewriter that drops a shared first path segment when every entry
 * lives under that folder (e.g. `repo-sha/src/a.js` → `src/a.js`).
 * @param {string[]} paths Normalized archive paths.
 * @returns {(path: string) => string}
 */
export function createArchiveRootRewriter(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return (path) => path;
  }
  const firstSegments = paths.map((path) => {
    const slash = path.indexOf('/');
    return slash === -1 ? path : path.slice(0, slash);
  });
  const root = firstSegments[0];
  const shared = Boolean(root) && firstSegments.every((segment) => segment === root);
  const hasNested = paths.some((path) => path.includes('/'));
  if (!shared || !hasNested) {
    return (path) => path;
  }
  const prefix = `${root}/`;
  return (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);
}

/**
 * Returns true when a writer lock or an overlapping job blocks persist.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   excludeJobId?: string | null,
 *   hasWriterLock?: typeof hasActiveProjectWriterLock,
 *   findActiveJob?: typeof findActiveJobForProjectByTypes,
 * }} input Scope.
 * @returns {Promise<boolean>}
 */
export async function isProjectSyncBlocked(input) {
  const hasWriterLock = input.hasWriterLock ?? hasActiveProjectWriterLock;
  const findActiveJob = input.findActiveJob ?? findActiveJobForProjectByTypes;
  const locked = await hasWriterLock({
    orgId: input.orgId,
    projectId: input.projectId,
  });
  if (locked) {
    return true;
  }
  const other = await findActiveJob(
    input.orgId,
    input.projectId,
    [...REPO_SYNC_OVERLAP_JOB_TYPES],
    { excludeJobId: input.excludeJobId ?? null },
  );
  return Boolean(other);
}

/**
 * Enqueues a manual `repo_sync` job (or returns the existing active one).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   actorUserId: string,
 *   correlationId?: string | null,
 *   log?: object,
 * }} input Enqueue inputs.
 * @returns {Promise<{ job: { id: string, jobType: string, jobStatus: string, scheduledAt: string } }>}
 */
export async function enqueueManualRepositorySync(input) {
  const connection = await findActiveConnection(input.orgId, input.projectId);
  if (!connection) {
    throw ApiError.fromCode('NOT_FOUND');
  }

  const existing = await findActiveJobForProjectByTypes(
    input.orgId,
    input.projectId,
    ['repo_sync'],
  );
  if (existing) {
    return { job: mapSyncJob(existing) };
  }

  const blocked = await isProjectSyncBlocked({
    orgId: input.orgId,
    projectId: input.projectId,
  });
  const scheduledAt = blocked
    ? new Date(Date.now() + REPO_SYNC_OVERLAP_RETRY_MS)
    : new Date();

  const { job } = await insertPendingJob({
    orgId: input.orgId,
    projectId: input.projectId,
    jobType: 'repo_sync',
    createdBy: input.actorUserId,
    correlationId: input.correlationId,
    scheduledAt,
  });

  await updateConnection({
    orgId: input.orgId,
    connectionId: String(connection._id),
    set: {
      lastSyncJobId: job._id,
      updatedBy: input.actorUserId,
    },
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'repository.sync_triggered',
      resourceType: 'repository',
      resourceId: String(connection._id),
      result: 'success',
      correlationId: input.correlationId ?? 'repository',
      context: { projectId: input.projectId, trigger: 'manual' },
    },
    { log: input.log },
  );

  return { job: mapSyncJob(job) };
}

/**
 * Persists a new repository SourceVersion from archive bytes and enqueues ingest.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   connectionId: string,
 *   branch: string,
 *   commitSha: string,
 *   archiveBuffer: Buffer,
 *   actorUserId?: string | null,
 *   correlationId?: string | null,
 * }} input Persist inputs.
 * @returns {Promise<{ sourceVersionId: string, ingestJobId: string }>}
 */
export async function persistRepositorySourceVersion(input) {
  const { entries } = await inspectZip(input.archiveBuffer);
  const rewritePath = createArchiveRootRewriter(entries.map((entry) => entry.path));
  const rewritten = entries.map((entry) => ({
    ...entry,
    path: rewritePath(entry.path),
  }));
  const inspection = summarizeInspection(rewritten);
  if (inspection.accepted.length === 0) {
    throw Object.assign(new Error('No files remained after exclusions.'), {
      failureClass: 'permanent',
      code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      probeStatus: null,
    });
  }

  const sourceVersionId = new mongoose.Types.ObjectId().toString();
  /** @type {import('mongoose').Types.ObjectId[]} */
  let gridFsIds = [];

  try {
    const stored = await storeAcceptedZipEntries({
      archiveBuffer: input.archiveBuffer,
      accepted: inspection.accepted,
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      rewritePath,
    });
    gridFsIds = stored.gridFsIds;

    const fileCounts = {
      accepted: inspection.accepted.length,
      skipped: inspection.skipped.length,
      excludedFromGraph: inspection.accepted.filter((row) => row.excludedFromGraph).length,
    };

    const session = await mongoose.startSession();
    let ingestJobId;
    try {
      await session.withTransaction(async () => {
        await insertSourceVersion(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            sourceVersionId,
            origin: SOURCE_ORIGIN_REPOSITORY,
            exclusionRulesetId: inspection.rulesetId,
            createdBy: input.actorUserId ?? null,
            fileCounts,
            commitSha: input.commitSha,
            branch: input.branch,
            repositoryConnectionId: input.connectionId,
          },
          { session },
        );
        await insertSourceFiles(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            sourceVersionId,
            createdBy: input.actorUserId ?? null,
            files: stored.files,
          },
          { session },
        );
        const pending = await createPendingJob(
          {
            orgId: input.orgId,
            projectId: input.projectId,
            jobType: 'ingest',
            createdBy: input.actorUserId ?? null,
            correlationId: input.correlationId,
            sourceVersionId,
          },
          { session },
        );
        ingestJobId = pending.jobId;
        await setSourceVersionJobId(
          {
            orgId: input.orgId,
            sourceVersionId,
            jobId: ingestJobId,
            updatedBy: input.actorUserId ?? null,
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    return { sourceVersionId, ingestJobId };
  } catch (error) {
    await markGridFsFilesOrphaned(gridFsIds);
    throw error;
  }
}

/**
 * Marks a connection after a successful sync (no-change or new version).
 * @param {{
 *   orgId: string,
 *   connectionId: string,
 *   commitSha: string,
 *   jobId: string,
 * }} input Update fields.
 * @returns {Promise<void>}
 */
export async function markConnectionSynced(input) {
  const now = new Date();
  await updateConnection({
    orgId: input.orgId,
    connectionId: input.connectionId,
    set: {
      lastSyncedCommitSha: input.commitSha,
      lastSyncedAt: now,
      nextDueAt: new Date(now.getTime() + REPO_SYNC_INTERVAL_MS),
      lastSyncJobId: input.jobId,
      lastSyncErrorCode: null,
      connectionStatus: 'connected',
      connectionStatusReasonCode: null,
    },
  });
}

/**
 * Records a pre-persist fetch failure on the connection without lifecycle change.
 * @param {{
 *   orgId: string,
 *   connectionId: string,
 *   probeStatus?: string | null,
 *   errorCode: string,
 *   jobId: string,
 * }} input Failure fields.
 * @returns {Promise<void>}
 */
export async function markConnectionSyncFailed(input) {
  /** @type {Record<string, unknown>} */
  const set = {
    lastSyncErrorCode: input.errorCode,
    lastSyncJobId: input.jobId,
    nextDueAt: new Date(Date.now() + REPO_SYNC_INTERVAL_MS),
  };
  if (input.probeStatus) {
    set.connectionStatus = input.probeStatus;
    set.connectionStatusReasonCode = input.errorCode;
  }
  await updateConnection({
    orgId: input.orgId,
    connectionId: input.connectionId,
    set,
  });
}

/**
 * Returns a running job to pending without burning an attempt.
 * @param {{
 *   jobId: string,
 *   orgId: string,
 *   delayMs?: number,
 * }} input Defer inputs.
 * @returns {Promise<object | null>}
 */
export async function deferRepoSyncJob(input) {
  return deferRunningJob({
    jobId: input.jobId,
    orgId: input.orgId,
    delayMs: input.delayMs ?? REPO_SYNC_OVERLAP_RETRY_MS,
  });
}

/**
 * @param {object} job Job document.
 * @returns {{ id: string, jobType: string, jobStatus: string, scheduledAt: string }}
 */
function mapSyncJob(job) {
  const scheduledAt =
    job.scheduledAt instanceof Date
      ? job.scheduledAt.toISOString()
      : String(job.scheduledAt ?? '');
  return {
    id: String(job._id),
    jobType: job.jobType,
    jobStatus: job.jobStatus,
    scheduledAt,
  };
}
