import { getAccessToken } from '@/shared/api';
import { useQuery } from '@tanstack/react-query';
import { CURRENT_USER_QUERY_KEY, fetchCurrentUser } from './authApi.js';

/** Current-user data is invalidated explicitly on login/logout; avoid idle refetches. */
export const CURRENT_USER_STALE_TIME_MS = Number.POSITIVE_INFINITY;

/**
 * Query for the signed-in user. Enabled only after boot left a bearer token.
 * @param {{ enabled?: boolean }} [options] Extra enable gate (boot ready).
 * @returns Current-user query result.
 */
export function useCurrentUser(options = {}) {
  const bootEnabled = options.enabled !== false;

  return useQuery({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: ({ signal }) => fetchCurrentUser({ signal }),
    enabled: bootEnabled && Boolean(getAccessToken()),
    staleTime: CURRENT_USER_STALE_TIME_MS,
  });
}
