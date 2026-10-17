/**
 * HTTP client for Phase 39 source file metadata and line-bounded slices.
 * Used by knowledge explorer and chat evidence preview — kept in shared so features
 * do not deep-import each other.
 */
import { apiRequest } from '@/shared/api';

/**
 * Builds the source preview React Query key.
 * @param {string} projectId Project id.
 * @param {string} path File path.
 * @param {{ startLine?: number, endLine?: number }} [range] Optional slice.
 * @returns {readonly unknown[]}
 */
export function sourcePreviewQueryKey(projectId, path, range = {}) {
  return Object.freeze(['projects', String(projectId), 'files', path, range.startLine ?? null, range.endLine ?? null]);
}

/**
 * Loads file metadata for a project-relative path.
 * @param {{ projectId: string, path: string, signal?: AbortSignal }} options Request.
 * @returns {Promise<object>}
 */
export async function fetchSourceFileMetadata(options) {
  const search = new URLSearchParams({ path: options.path });
  return apiRequest(`/knowledge/sourcePreview/getMetadata/${encodeURIComponent(options.projectId)}?${search.toString()}`, {
    signal: options.signal,
  });
}

/**
 * Loads a bounded line slice for preview.
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
  return apiRequest(`/knowledge/sourcePreview/readSlice/${encodeURIComponent(options.projectId)}?${search.toString()}`, {
    signal: options.signal,
  });
}
