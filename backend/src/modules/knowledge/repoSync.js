/**
 * knowledge/repoSync.js — merged resource file.
 */
import { loadConfig } from '../../platform/config.js';
import { ApiError } from '../../platform/errors.js';
import { hasActiveProjectWriterLock } from '../../worker/projectJobLock.js';
import { recordAuditEvent } from '../access/index.js';
import { insertPendingJob, findActiveJobForProjectByTypes, createPendingJob, deferRunningJob } from '../masters/index.js';
import {
  assertHostAllowed,
  outboundGet,
  githubHeaders,
  gitlabApiBase,
  gitlabHeaders,
  mapAuthenticatedLookupStatus,
  mapAnonymousLookupStatus,
  mapOutboundThrown,
} from './repositories.helper.js';
import { listDueConnections, updateConnection, findActiveConnection, decryptConnectionToken } from './repositories.js';
import { insertSourceFiles, insertSourceVersion, markGridFsFilesOrphaned, setSourceVersionJobId, SOURCE_ORIGIN_REPOSITORY } from './sources.js';
import { inspectZip, storeAcceptedZipEntries, summarizeInspection, UPLOAD_MAX_ARCHIVE_BYTES } from './uploads.js';
import mongoose from 'mongoose';

// --- from repositories/sync/repoSync.constants.js ---
/**
 * Named constants for repository sync (not env).
 */

/** Default cadence per active connection. */
export const REPO_SYNC_INTERVAL_MS = 1_800_000;

/** How often the worker scans due connections. */
export const REPO_SYNC_SCHEDULER_TICK_MS = 60_000;

/** Defer when a project writer or overlapping job is active. */
export const REPO_SYNC_OVERLAP_RETRY_MS = 120_000;

/** Wall clock for remote HEAD + archive download. */
export const REPO_SYNC_FETCH_TIMEOUT_MS = 600_000;

/** Job types that block a concurrent repo_sync persist. */
export const REPO_SYNC_OVERLAP_JOB_TYPES = Object.freeze(['ingest', 'reingest', 'repo_sync']);

/** GitHub hosts allowed after an api.github.com zipball redirect. */
export const GITHUB_ARCHIVE_REDIRECT_HOSTS = Object.freeze(['codeload.github.com']);

// --- from repositories/sync/outboundDownload.js ---
/**
 * Binary outbound GET for repository archives (timeout, redirects, size cap).
 */
const MAX_REDIRECTS = 5;

/**
 * @typedef {{
 *   status: number,
 *   headers: Headers,
 *   buffer: Buffer,
 * }} OutboundDownloadResponse
 */

/**
 * Downloads a binary body with host guards and an archive size cap.
 * GitHub zipball may redirect to `codeload.github.com`; auth headers are dropped
 * on that cross-host hop.
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   allowPrivateHosts?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} input Request.
 * @returns {Promise<OutboundDownloadResponse>}
 */
export async function outboundDownload(input) {
  const timeoutMs = input.timeoutMs ?? REPO_SYNC_FETCH_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? UPLOAD_MAX_ARCHIVE_BYTES;
  const allowPrivateHosts = input.allowPrivateHosts ?? loadConfig().repositories.allowPrivateHosts;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const startHost = new URL(input.url).host;
  let currentUrl = input.url;
  /** @type {Record<string, string> | undefined} */
  let currentHeaders = input.headers;
  let redirects = 0;

  for (;;) {
    assertHostAllowed(currentUrl, allowPrivateHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: currentHeaders,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'AbortError') {
        throw Object.assign(new Error('Repository archive download timed out.'), {
          code: 'PROBE_TIMEOUT',
        });
      }
      throw Object.assign(new Error('Repository host could not be reached.'), {
        code: 'PROBE_NETWORK',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('location');
      if (!location || redirects >= MAX_REDIRECTS) {
        throw Object.assign(new Error('Repository archive exceeded redirect limit.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedArchiveRedirect(startHost, new URL(currentUrl).host, nextUrl.host)) {
        throw Object.assign(new Error('Repository archive refused a cross-host redirect.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      if (nextUrl.host !== startHost) {
        currentHeaders = { 'User-Agent': 'codex-sage' };
      }
      currentUrl = nextUrl.toString();
      redirects += 1;
      continue;
    }

    if (response.status !== 200) {
      return {
        status: response.status,
        headers: response.headers,
        buffer: Buffer.alloc(0),
      };
    }

    const buffer = await readBinaryCapped(response, maxBytes);
    return {
      status: response.status,
      headers: response.headers,
      buffer,
    };
  }
}

/**
 * @param {string} startHost Original request host.
 * @param {string} currentHost Host of the last request.
 * @param {string} nextHost Redirect target host.
 * @returns {boolean}
 */
export function isAllowedArchiveRedirect(startHost, currentHost, nextHost) {
  if (nextHost === currentHost) {
    return true;
  }
  return startHost === 'api.github.com' && GITHUB_ARCHIVE_REDIRECT_HOSTS.includes(nextHost);
}

/**
 * Reads a response body up to maxBytes.
 * @param {Response} response Fetch response.
 * @param {number} maxBytes Size cap.
 * @returns {Promise<Buffer>}
 */
async function readBinaryCapped(response, maxBytes) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error('Repository archive exceeded the size cap.'), {
        code: 'PROBE_SIZE',
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((part) => Buffer.from(part)));
}

// --- from repositories/sync/archiveSyncAdapter.js ---
/**
 * Provider API archive adapter — resolve HEAD SHA, then download zip bytes.
 */
/**
 * @typedef {{
 *   provider: 'github' | 'gitlab',
 *   baseUrl: string | null,
 *   fullName: string,
 *   branch: string,
 *   token?: string | null,
 *   signal?: AbortSignal,
 *   outboundGet?: typeof outboundGet,
 *   outboundDownload?: typeof outboundDownload,
 * }} RemoteFetchInput
 */

/**
 * Resolves the current commit SHA for the selected branch.
 * @param {RemoteFetchInput} input Fetch inputs.
 * @returns {Promise<{ commitSha: string, commitMessage: string | null }>}
 */
export async function resolveRemoteHead(input) {
  try {
    if (input.provider === 'github') {
      return await resolveGithubHead(input);
    }
    return await resolveGitlabHead(input);
  } catch (err) {
    if (isMappedSyncError(err)) {
      throw err;
    }
    throwMapped(mapOutboundThrown(err), input.token);
  }
}

/**
 * Downloads the repository archive for a known commit SHA.
 * @param {RemoteFetchInput & { commitSha: string }} input Fetch inputs.
 * @returns {Promise<{ archiveBuffer: Buffer }>}
 */
export async function downloadRepositoryArchive(input) {
  try {
    if (input.provider === 'github') {
      return await downloadGithubArchive(input);
    }
    return await downloadGitlabArchive(input);
  } catch (err) {
    if (isMappedSyncError(err)) {
      throw err;
    }
    throwMapped(mapOutboundThrown(err), input.token);
  }
}

/**
 * @param {RemoteFetchInput} input Inputs.
 * @returns {Promise<{ commitSha: string, commitMessage: string | null }>}
 */
async function resolveGithubHead(input) {
  const { owner, repo } = splitGithubFullName(input.fullName);
  const get = input.outboundGet ?? outboundGet;
  const response = await get({
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/` + `${encodeURIComponent(repo)}/commits/${encodeURIComponent(input.branch)}`,
    headers: githubHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.json || typeof response.json.sha !== 'string') {
    throwMapped(input.token ? mapAuthenticatedLookupStatus(response.status) : mapAnonymousLookupStatus(response.status), input.token);
  }
  const message = typeof response.json.commit?.message === 'string' ? response.json.commit.message : null;
  return { commitSha: response.json.sha, commitMessage: message };
}

/**
 * @param {RemoteFetchInput} input Inputs.
 * @returns {Promise<{ commitSha: string, commitMessage: string | null }>}
 */
async function resolveGitlabHead(input) {
  const get = input.outboundGet ?? outboundGet;
  const encoded = encodeURIComponent(input.fullName);
  const response = await get({
    url: `${gitlabApiBase(input.baseUrl)}/projects/${encoded}/repository/commits/` + `${encodeURIComponent(input.branch)}`,
    headers: gitlabHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.json || typeof response.json.id !== 'string') {
    throwMapped(input.token ? mapAuthenticatedLookupStatus(response.status) : mapAnonymousLookupStatus(response.status), input.token);
  }
  const message = typeof response.json.message === 'string' ? response.json.message : null;
  return { commitSha: response.json.id, commitMessage: message };
}

/**
 * @param {RemoteFetchInput & { commitSha: string }} input Inputs.
 * @returns {Promise<{ archiveBuffer: Buffer }>}
 */
async function downloadGithubArchive(input) {
  const { owner, repo } = splitGithubFullName(input.fullName);
  const download = input.outboundDownload ?? outboundDownload;
  const response = await download({
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/` + `${encodeURIComponent(repo)}/zipball/${encodeURIComponent(input.commitSha)}`,
    headers: githubHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.buffer.length) {
    throwMapped(input.token ? mapAuthenticatedLookupStatus(response.status) : mapAnonymousLookupStatus(response.status), input.token);
  }
  return { archiveBuffer: response.buffer };
}

/**
 * @param {RemoteFetchInput & { commitSha: string }} input Inputs.
 * @returns {Promise<{ archiveBuffer: Buffer }>}
 */
async function downloadGitlabArchive(input) {
  const download = input.outboundDownload ?? outboundDownload;
  const encoded = encodeURIComponent(input.fullName);
  const response = await download({
    url: `${gitlabApiBase(input.baseUrl)}/projects/${encoded}/repository/archive.zip` + `?sha=${encodeURIComponent(input.commitSha)}`,
    headers: gitlabHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.buffer.length) {
    throwMapped(input.token ? mapAuthenticatedLookupStatus(response.status) : mapAnonymousLookupStatus(response.status), input.token);
  }
  return { archiveBuffer: response.buffer };
}

/**
 * @param {string} fullName owner/repo or nested GitLab path.
 * @returns {{ owner: string, repo: string }}
 */
export function splitGithubFullName(fullName) {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) {
    throwMapped(mapAnonymousLookupStatus(404), null);
  }
  return {
    owner: fullName.slice(0, slash),
    repo: fullName.slice(slash + 1),
  };
}

/**
 * @param {unknown} err Thrown value.
 * @returns {boolean}
 */
function isMappedSyncError(err) {
  return Boolean(err && typeof err === 'object' && 'failureClass' in err && 'probeStatus' in err && 'code' in err);
}

/**
 * @param {{ probeStatus: string, reason: { code: string, message: string } }} mapped
 *   Probe mapping.
 * @param {string | null | undefined} token Token presence for class.
 * @returns {never}
 */
function throwMapped(mapped, token) {
  const temporaryCodes = new Set(['network_unreachable', 'provider_unavailable', 'provider_rate_limited']);
  const failureClass = temporaryCodes.has(mapped.reason.code) ? 'temporary' : 'user_action_required';
  void token;
  throw Object.assign(new Error(mapped.reason.message), {
    failureClass,
    code: mapped.reason.code,
    probeStatus: mapped.probeStatus,
  });
}

// --- from repositories/sync/repoSync.scheduler.js ---
/**
 * Worker-only scan that enqueues due `repo_sync` jobs.
 */
/**
 * Enqueues `repo_sync` for each due active connection that is not overlapping.
 * @param {{
 *   now?: Date,
 *   log?: { error?: Function, info?: Function },
 *   listDue?: typeof listDueConnections,
 * }} [input] Optional seams.
 * @returns {Promise<{ enqueued: number, skipped: number }>}
 */
export async function enqueueDueRepositorySyncs(input = {}) {
  const now = input.now ?? new Date();
  const listDue = input.listDue ?? listDueConnections;
  const due = await listDue(now);
  let enqueued = 0;
  let skipped = 0;

  for (const connection of due) {
    const orgId = String(connection.orgId);
    const projectId = String(connection.projectId);
    try {
      const existing = await findActiveJobForProjectByTypes(orgId, projectId, ['repo_sync']);
      if (existing) {
        skipped += 1;
        continue;
      }
      const blocked = await isProjectSyncBlocked({ orgId, projectId });
      if (blocked) {
        skipped += 1;
        continue;
      }
      const { job } = await insertPendingJob({
        orgId,
        projectId,
        jobType: 'repo_sync',
        createdBy: null,
        scheduledAt: now,
      });
      await updateConnection({
        orgId,
        connectionId: String(connection._id),
        set: {
          lastSyncJobId: job._id,
          nextDueAt: new Date(now.getTime() + REPO_SYNC_INTERVAL_MS),
        },
      });
      enqueued += 1;
    } catch (err) {
      skipped += 1;
      input.log?.error?.(
        {
          orgId,
          projectId,
          errName: err instanceof Error ? err.name : 'Error',
        },
        'repo_sync scheduler failed for connection',
      );
    }
  }

  if (enqueued > 0) {
    input.log?.info?.({ enqueued, skipped }, 'repo_sync scheduler enqueued due work');
  }
  return { enqueued, skipped };
}

// --- from repositories/sync/repoSync.service.js ---
/**
 * Repository sync orchestration: enqueue, persist archive, and connection updates.
 */
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
  const other = await findActiveJob(input.orgId, input.projectId, [...REPO_SYNC_OVERLAP_JOB_TYPES], { excludeJobId: input.excludeJobId ?? null });
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

  const existing = await findActiveJobForProjectByTypes(input.orgId, input.projectId, ['repo_sync']);
  if (existing) {
    return { job: mapSyncJob(existing) };
  }

  const blocked = await isProjectSyncBlocked({
    orgId: input.orgId,
    projectId: input.projectId,
  });
  const scheduledAt = blocked ? new Date(Date.now() + REPO_SYNC_OVERLAP_RETRY_MS) : new Date();

  const mongoSession = await mongoose.startSession();
  /** @type {import('mongoose').Document | undefined} */
  let job;
  try {
    await mongoSession.withTransaction(async () => {
      const inserted = await insertPendingJob(
        {
          orgId: input.orgId,
          projectId: input.projectId,
          jobType: 'repo_sync',
          createdBy: input.actorUserId,
          correlationId: input.correlationId,
          scheduledAt,
        },
        { session: mongoSession },
      );
      job = inserted.job;
      await updateConnection(
        {
          orgId: input.orgId,
          connectionId: String(connection._id),
          set: {
            lastSyncJobId: job._id,
            updatedBy: input.actorUserId,
          },
        },
        { session: mongoSession },
      );
    });
  } finally {
    await mongoSession.endSession();
  }
  if (!job) {
    throw ApiError.fromCode('INTERNAL_ERROR');
  }

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
  const scheduledAt = job.scheduledAt instanceof Date ? job.scheduledAt.toISOString() : String(job.scheduledAt ?? '');
  return {
    id: String(job._id),
    jobType: job.jobType,
    jobStatus: job.jobStatus,
    scheduledAt,
  };
}

// --- from repositories/sync/repoSync.handler.js ---
/**
 * Worker handler for `repo_sync` — fetch HEAD, persist on new SHA, enqueue ingest.
 */
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
    throw err;
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
