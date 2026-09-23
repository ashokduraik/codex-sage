/**
 * Source file metadata and slice HTTP calls (Phase 39).
 */
import { apiRequest } from '@/shared/api';

/**
 * Loads file metadata for a project-relative path.
 * @param {{ projectId: string, path: string, signal?: AbortSignal }} options Request.
 * @returns {Promise<object>}
 */
export async function fetchSourceFileMetadata(options) {
  const search = new URLSearchParams({ path: options.path });
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/files?${search.toString()}`,
    { signal: options.signal },
  );
}

/**
 * Loads a bounded line slice.
 * @param {{
 *   projectId: string,
 *   path: string,
 *   startLine: number,
 *   endLine: number,
 *   signal?: AbortSignal,
 * }} options Request.
 * @returns {Promise<object>}
 */
export async function fetchSourceSlice(options) {
  const search = new URLSearchParams({
    path: options.path,
    startLine: String(options.startLine),
    endLine: String(options.endLine),
  });
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/files/slice?${search.toString()}`,
    { signal: options.signal },
  );
}
