/**
 * Admin audit HTTP calls and React Query keys (Phase 16).
 */
import { apiRequest } from '@/shared/api';

/**
 * Builds the audit-events infinite-query key from filter state (cursor is not in the key).
 * @param {{
 *   from?: string,
 *   to?: string,
 *   actor?: string,
 *   action?: string,
 *   resourceType?: string,
 *   limit?: number,
 * }} filters List filters.
 * @returns {readonly unknown[]}
 */
export function adminAuditEventsQueryKey(filters = {}) {
  return Object.freeze([
    'admin',
    'audit-events',
    {
      from: filters.from ?? '',
      to: filters.to ?? '',
      actor: filters.actor ?? '',
      action: filters.action ?? '',
      resourceType: filters.resourceType ?? '',
      limit: filters.limit ?? null,
    },
  ]);
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
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({
    from: filters.from,
    to: filters.to,
    actor: filters.actor,
    action: filters.action,
    resourceType: filters.resourceType,
    cursor: filters.cursor,
    limit: filters.limit,
  })) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return apiRequest(`/audit-events${encoded ? `?${encoded}` : ''}`, { signal });
}
