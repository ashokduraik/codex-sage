/**
 * Provider API archive adapter — resolve HEAD SHA, then download zip bytes.
 */
import { outboundGet } from '../providers/outboundHttp.js';
import { githubHeaders } from '../providers/githubProbe.js';
import { gitlabApiBase, gitlabHeaders } from '../providers/gitlabProbe.js';
import {
  mapAuthenticatedLookupStatus,
  mapAnonymousLookupStatus,
  mapOutboundThrown,
} from '../providers/probeErrorMap.js';
import { outboundDownload } from './outboundDownload.js';
import { REPO_SYNC_FETCH_TIMEOUT_MS } from './repoSync.constants.js';

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
    url:
      `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/commits/${encodeURIComponent(input.branch)}`,
    headers: githubHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.json || typeof response.json.sha !== 'string') {
    throwMapped(
      input.token
        ? mapAuthenticatedLookupStatus(response.status)
        : mapAnonymousLookupStatus(response.status),
      input.token,
    );
  }
  const message =
    typeof response.json.commit?.message === 'string' ? response.json.commit.message : null;
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
    url:
      `${gitlabApiBase(input.baseUrl)}/projects/${encoded}/repository/commits/` +
      `${encodeURIComponent(input.branch)}`,
    headers: gitlabHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.json || typeof response.json.id !== 'string') {
    throwMapped(
      input.token
        ? mapAuthenticatedLookupStatus(response.status)
        : mapAnonymousLookupStatus(response.status),
      input.token,
    );
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
    url:
      `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/zipball/${encodeURIComponent(input.commitSha)}`,
    headers: githubHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.buffer.length) {
    throwMapped(
      input.token
        ? mapAuthenticatedLookupStatus(response.status)
        : mapAnonymousLookupStatus(response.status),
      input.token,
    );
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
    url:
      `${gitlabApiBase(input.baseUrl)}/projects/${encoded}/repository/archive.zip` +
      `?sha=${encodeURIComponent(input.commitSha)}`,
    headers: gitlabHeaders(input.token),
    timeoutMs: REPO_SYNC_FETCH_TIMEOUT_MS,
  });
  if (response.status !== 200 || !response.buffer.length) {
    throwMapped(
      input.token
        ? mapAuthenticatedLookupStatus(response.status)
        : mapAnonymousLookupStatus(response.status),
      input.token,
    );
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
  return Boolean(
    err &&
      typeof err === 'object' &&
      'failureClass' in err &&
      'probeStatus' in err &&
      'code' in err,
  );
}

/**
 * @param {{ probeStatus: string, reason: { code: string, message: string } }} mapped
 *   Probe mapping.
 * @param {string | null | undefined} token Token presence for class.
 * @returns {never}
 */
function throwMapped(mapped, token) {
  const temporaryCodes = new Set([
    'network_unreachable',
    'provider_unavailable',
    'provider_rate_limited',
  ]);
  const failureClass = temporaryCodes.has(mapped.reason.code)
    ? 'temporary'
    : 'user_action_required';
  void token;
  throw Object.assign(new Error(mapped.reason.message), {
    failureClass,
    code: mapped.reason.code,
    probeStatus: mapped.probeStatus,
  });
}
