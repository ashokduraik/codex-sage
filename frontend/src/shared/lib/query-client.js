import { ApiError } from '@/shared/api/ApiError.js';
import { QueryClient } from '@tanstack/react-query';

/** Default query stale time — admin lists tolerate it; hot status slices override. */
export const QUERY_STALE_TIME_MS = 30_000;

/** Unused query cache garbage-collection time. */
export const QUERY_GC_TIME_MS = 5 * 60_000;

/** Max retries for network / 5xx query failures. */
export const QUERY_RETRY_MAX = 2;

/** Cap for exponential retry delay. */
export const QUERY_RETRY_DELAY_MAX_MS = 30_000;

/**
 * Decides whether a failed query should retry.
 * Client and authorization/validation failures (4xx) are not retried.
 * @param {number} failureCount Retries already attempted.
 * @param {unknown} error Failure value.
 * @returns {boolean}
 */
export function shouldRetryQuery(failureCount, error) {
  if (failureCount >= QUERY_RETRY_MAX) {
    return false;
  }
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) {
      return false;
    }
    return error.status === 0 || error.status >= 500;
  }
  return true;
}

/**
 * Exponential backoff delay capped at `QUERY_RETRY_DELAY_MAX_MS`.
 * @param {number} attemptIndex Zero-based retry attempt index.
 * @returns {number} Delay in milliseconds.
 */
export function queryRetryDelay(attemptIndex) {
  return Math.min(1000 * 2 ** attemptIndex, QUERY_RETRY_DELAY_MAX_MS);
}

/** Shared React Query client with app-wide defaults. */
export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
      staleTime: QUERY_STALE_TIME_MS,
      gcTime: QUERY_GC_TIME_MS,
      throwOnError: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
