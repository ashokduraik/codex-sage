/**
 * Project source upload and version-list HTTP calls.
 */
import { apiRequest } from '@/shared/api';
import { apiUpload } from '@/shared/api/apiUpload.js';

/** Default page size for GET /projects/:projectId/source-versions. */
export const SOURCE_VERSION_LIST_PAGE_SIZE = 20;

/**
 * Builds the source-versions list query key.
 * @param {string} projectId Project id.
 * @returns {readonly unknown[]}
 */
export function sourceVersionsQueryKey(projectId) {
  return Object.freeze(['projects', String(projectId), 'source-versions']);
}

/**
 * Builds a query string from defined filter values.
 * @param {Record<string, string | number | undefined | null>} params Query map.
 * @returns {string}
 */
function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Lists source versions for a project.
 * @param {{
 *   projectId: string,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} options List options.
 * @returns {Promise<import('./sourceTypes.js').SourceVersionListPage>}
 */
export async function listProjectSourceVersions(options) {
  const query = toQueryString({
    cursor: options.cursor,
    limit: options.limit ?? SOURCE_VERSION_LIST_PAGE_SIZE,
  });
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/source-versions${query}`,
    { signal: options.signal },
  );
}

/**
 * Uploads a ZIP archive as a new source version.
 * @param {{
 *   projectId: string,
 *   file: File,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onUploadProgress?: (progress: { loaded: number, total: number }) => void,
 * }} input Upload inputs.
 * @returns {Promise<import('./sourceTypes.js').SourceUploadResult>}
 */
export async function uploadProjectSource(input) {
  const body = new FormData();
  body.append('archive', input.file, input.file.name);
  return apiUpload(`/projects/${encodeURIComponent(input.projectId)}/sources`, {
    method: 'POST',
    body,
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    onUploadProgress: input.onUploadProgress,
  });
}
