/**
 * Repository probe and attach HTTP calls (Phase 30 / 31).
 */
import { apiRequest } from '@/shared/api';

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
 * @returns {Promise<import('./repositoryTypes.js').RepositoryProbeDto>}
 */
export async function probeProjectRepository(input) {
  const body = { repositoryUrl: input.repositoryUrl };
  if (input.accessToken) {
    body.accessToken = input.accessToken;
  }
  return apiRequest(
    `/projects/${encodeURIComponent(input.projectId)}/repositories/probe`,
    {
      method: 'POST',
      body,
      signal: input.signal,
    },
  );
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
 * @returns {Promise<import('./repositoryTypes.js').RepositoryAttachResult>}
 */
export async function attachProjectRepository(input) {
  const body = {
    repositoryUrl: input.repositoryUrl,
    selectedBranch: input.selectedBranch,
  };
  if (input.accessToken) {
    body.accessToken = input.accessToken;
  }
  return apiRequest(`/projects/${encodeURIComponent(input.projectId)}/repositories`, {
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
 * @returns {Promise<{ connection: import('./repositoryTypes.js').RepositoryConnectionDto }>}
 */
export async function getProjectRepositoryConnection(projectId, options = {}) {
  return apiRequest(
    `/projects/${encodeURIComponent(projectId)}/repositories/connection`,
    { signal: options.signal },
  );
}
