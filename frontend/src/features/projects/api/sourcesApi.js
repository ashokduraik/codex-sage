/**
 * Project source upload and version-list HTTP calls.
 * DTO shapes for source upload and version list.
 */
import { apiRequest } from '@/shared/api';
import { apiUpload } from '@/shared/api/apiUpload.js';

/**
 * @typedef {{
 *   sourceVersionId: string,
 *   jobId: string,
 * }} SourceUploadResult
 */

/**
 * @typedef {{
 *   id: string,
 *   origin: 'upload' | 'repository' | string,
 *   versionLifecycle: string,
 *   fileCounts: { accepted: number, skipped: number, excludedFromGraph: number },
 *   jobId: string | null,
 *   commitSha: string | null,
 *   branch: string | null,
 *   createdBy: string | null,
 *   createdAt: string | null,
 * }} SourceVersionDto
 */

/**
 * @typedef {{
 *   items: SourceVersionDto[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }} SourceVersionListPage
 */

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
 * Lists source versions for a project.
 * @param {{
 *   projectId: string,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} options List options.
 * @returns {Promise<SourceVersionListPage>}
 */
export async function listProjectSourceVersions(options) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({
    cursor: options.cursor,
    limit: options.limit ?? SOURCE_VERSION_LIST_PAGE_SIZE,
  })) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/source-versions${
      encoded ? `?${encoded}` : ''
    }`,
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
 * @returns {Promise<SourceUploadResult>}
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
