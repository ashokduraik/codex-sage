/**
 * Admin audit HTTP calls over the shared API client (Phase 16).
 */
import { apiRequest } from '@/shared/api';

/**
 * Builds a query string from defined filter values.
 * @param {Record<string, string | number | undefined | null>} params Query map.
 * @returns {string} Path suffix starting with `?`, or empty string.
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
 * Lists organization audit events with keyset pagination and filters.
 * @param {{
 *   from?: string,
 *   to?: string,
 *   actor?: string,
 *   action?: string,
 *   resourceType?: string,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] List options.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listAuditEvents(options = {}) {
  const { signal, ...filters } = options;
  const query = toQueryString({
    from: filters.from,
    to: filters.to,
    actor: filters.actor,
    action: filters.action,
    resourceType: filters.resourceType,
    cursor: filters.cursor,
    limit: filters.limit,
  });
  return apiRequest(`/audit-events${query}`, { signal });
}
