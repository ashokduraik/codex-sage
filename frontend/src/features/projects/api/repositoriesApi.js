/**
 * Repository probe and attach HTTP calls (Phase 30 / 31).
 * Probe and attach DTO shapes.
 */
import { apiRequest } from '@/shared/api';

/**
 * @typedef {'connected' | 'authentication_required' | 'access_denied' | 'not_found' | 'unreachable'} ProbeStatus
 */

/**
 * @typedef {{
 *   fullName: string,
 *   webUrl?: string | null,
 *   visibility?: string | null,
 *   description?: string | null,
 * }} ProbeRepository
 */

/**
 * @typedef {{
 *   probeStatus: ProbeStatus | string,
 *   provider?: 'github' | 'gitlab' | string,
 *   hostKind?: string,
 *   baseUrl?: string | null,
 *   repository?: ProbeRepository,
 *   defaultBranch?: string,
 *   branches?: string[],
 *   branchesTruncated?: boolean,
 *   tokenUsed?: boolean,
 *   reason?: { code?: string, message?: string },
 * }} RepositoryProbeDto
 */

/**
 * @typedef {{
 *   id: string,
 *   provider: string,
 *   hostKind: string,
 *   baseUrl: string | null,
 *   repository: { fullName: string, webUrl?: string | null, visibility?: string | null },
 *   selectedBranch: string,
 *   defaultBranch: string,
 *   connectionStatus: string,
 *   connectionStatusReasonCode?: string | null,
 *   lastSuccessfulProbeAt?: string | null,
 *   attachedAt?: string | null,
 *   lastSyncedCommitSha?: string | null,
 *   lastSyncedAt?: string | null,
 *   nextDueAt?: string | null,
 * }} RepositoryConnectionDto
 */

/**
 * @typedef {{
 *   connection: RepositoryConnectionDto,
 *   project?: object,
 * }} RepositoryAttachResult
 */

/**
 * Builds the connection cache key for a project.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function repositoryConnectionQueryKey(projectId) {
  return Object.freeze(['projects', String(projectId), 'repositories', 'connection']);
}

/**
 * Probes a repository URL. Probe outcomes arrive as HTTP 200 + probeStatus.
 * @param {{
 *   projectId: string,
 *   repositoryUrl: string,
 *   accessToken?: string,
 *   signal?: AbortSignal,
 * }} input Probe inputs.
 * @returns {Promise<RepositoryProbeDto>}
 */
export async function probeProjectRepository(input) {
  const body = { repositoryUrl: input.repositoryUrl };
  if (input.accessToken) {
    body.accessToken = input.accessToken;
  }
  return apiRequest(`/knowledge/repositories/probe/${encodeURIComponent(input.projectId)}`, {
    method: 'POST',
    body,
    signal: input.signal,
  });
}

/**
 * Attaches a probed repository (Idempotency-Key required).
 * @param {{
 *   projectId: string,
 *   repositoryUrl: string,
 *   selectedBranch: string,
 *   accessToken?: string,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 * }} input Attach inputs.
 * @returns {Promise<RepositoryAttachResult>}
 */
export async function attachProjectRepository(input) {
  const body = {
    repositoryUrl: input.repositoryUrl,
    selectedBranch: input.selectedBranch,
  };
  if (input.accessToken) {
    body.accessToken = input.accessToken;
  }
  return apiRequest(`/knowledge/repositories/attach/${encodeURIComponent(input.projectId)}`, {
    method: 'POST',
    body,
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
  });
}

/**
 * Loads the active repository connection for a project.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<{ connection: RepositoryConnectionDto }>}
 */
export async function getProjectRepositoryConnection(projectId, options = {}) {
  return apiRequest(`/knowledge/repositories/getConnection/${encodeURIComponent(projectId)}`, { signal: options.signal });
}

/**
 * Replaces the stored repository credential (write-only token).
 * @param {{
 *   projectId: string,
 *   accessToken: string,
 *   signal?: AbortSignal,
 * }} input Replace inputs.
 * @returns {Promise<{ connection: RepositoryConnectionDto, connectionStatus?: string }>}
 */
export async function replaceProjectRepositoryCredential(input) {
  return apiRequest(`/knowledge/repositories/replaceCredential/${encodeURIComponent(input.projectId)}`, {
    method: 'POST',
    body: { accessToken: input.accessToken },
    signal: input.signal,
  });
}

/**
 * Revokes the stored credential and disconnects the repository.
 * @param {{
 *   projectId: string,
 *   signal?: AbortSignal,
 * }} input Revoke inputs.
 * @returns {Promise<void>}
 */
export async function revokeProjectRepositoryCredential(input) {
  return apiRequest(`/knowledge/repositories/revokeCredential/${encodeURIComponent(input.projectId)}`, {
    method: 'POST',
    signal: input.signal,
  });
}

/**
 * Re-tests the stored connection against the remote.
 * @param {{
 *   projectId: string,
 *   signal?: AbortSignal,
 * }} input Re-test inputs.
 * @returns {Promise<{ connectionStatus: string, reason?: object }>}
 */
export async function retestProjectRepositoryConnection(input) {
  return apiRequest(`/knowledge/repositories/retestConnection/${encodeURIComponent(input.projectId)}`, {
    method: 'POST',
    signal: input.signal,
  });
}
