/**
 * Project search HTTP calls (Phase 38).
 */
import { apiRequest } from '@/shared/api';

/** Debounce for the search input. */
export const KNOWLEDGE_SEARCH_DEBOUNCE_MS = 300;

/**
 * Runs project-scoped knowledge search.
 * @param {{
 *   projectId: string,
 *   q: string,
 *   types?: string,
 *   signal?: AbortSignal,
 * }} options Search options.
 * @returns {Promise<object>}
 */
export async function fetchProjectSearch(options) {
  const search = new URLSearchParams();
  search.set('q', options.q);
  if (options.types) {
    search.set('types', options.types);
  }
  return apiRequest(
    `/projects/${encodeURIComponent(options.projectId)}/search?${search.toString()}`,
    { signal: options.signal },
  );
}
