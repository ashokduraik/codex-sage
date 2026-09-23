/**
 * Change-summary HTTP calls (Phase 39).
 */
import { ApiError, apiRequest } from '@/shared/api';

/**
 * Loads the latest computed change summary. 404 becomes null.
 * @param {string} projectId Project id.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<object | null>}
 */
export async function fetchChangeSummary(projectId, options = {}) {
  try {
    return await apiRequest(
      `/projects/${encodeURIComponent(projectId)}/knowledge/updates/latest`,
      { signal: options.signal },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.code === 'CHANGE_SUMMARY_NOT_FOUND')
    ) {
      return null;
    }
    throw error;
  }
}
