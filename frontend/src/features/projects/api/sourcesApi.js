/**
 * Project source upload HTTP calls.
 */
import { apiUpload } from '@/shared/api/apiUpload.js';

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
