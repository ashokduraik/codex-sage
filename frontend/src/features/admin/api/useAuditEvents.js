import { useInfiniteQuery } from '@tanstack/react-query';
import { ApiError } from '@/shared/api';
import { listAuditEvents } from './auditApi.js';
import { adminAuditEventsQueryKey } from './adminKeys.js';

/**
 * True when the failure is an invalid/malformed pagination cursor.
 * @param {unknown} error Caught value.
 * @returns {boolean}
 */
export function isInvalidAuditCursorError(error) {
  if (!(error instanceof ApiError)) {
    return false;
  }
  if (error.code === 'INVALID_CURSOR') {
    return true;
  }
  if (error.code !== 'VALIDATION_ERROR') {
    return false;
  }
  if (!Array.isArray(error.details)) {
    return false;
  }
  return error.details.some(
    (detail) =>
      detail &&
      typeof detail === 'object' &&
      /** @type {{ path?: unknown }} */ (detail).path === 'cursor',
  );
}

/**
 * Infinite keyset list of audit events for the given filters (filters belong in the query key).
 * @param {{
 *   from?: string,
 *   to?: string,
 *   actor?: string,
 *   action?: string,
 *   resourceType?: string,
 *   limit?: number,
 *   enabled?: boolean,
 * }} filters List filters from the URL.
 * @returns Infinite query result for audit events.
 */
export function useAuditEvents(filters = {}) {
  const enabled = filters.enabled !== false;
  const queryFilters = {
    from: filters.from,
    to: filters.to,
    actor: filters.actor,
    action: filters.action,
    resourceType: filters.resourceType,
    limit: filters.limit,
  };

  return useInfiniteQuery({
    queryKey: adminAuditEventsQueryKey(queryFilters),
    queryFn: ({ pageParam, signal }) =>
      listAuditEvents({
        ...queryFilters,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => {
      const nextCursor = lastPage?.pageInfo?.nextCursor;
      if (lastPage?.pageInfo?.hasMore && typeof nextCursor === 'string' && nextCursor) {
        return nextCursor;
      }
      return undefined;
    },
    enabled,
  });
}
