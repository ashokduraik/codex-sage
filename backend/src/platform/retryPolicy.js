/**
 * Retry classification and capped exponential backoff with full jitter.
 * Workers (phase 21) and Ollama callers (phase 45) must use these helpers —
 * they must not re-implement retryability.
 */
import { getCatalogEntry } from './errorCatalog.js';

/** First backoff step for temporary failures (ms). */
export const RETRY_BASE_DELAY_MS = 1000;
/** Upper bound for backoff delay (ms). */
export const RETRY_MAX_DELAY_MS = 60_000;
/** Attempt ceiling for auto-retry of temporary failures. */
export const RETRY_MAX_ATTEMPTS = 5;

/**
 * Default policy used when callers omit overrides.
 * @type {{ baseDelayMs: number, maxDelayMs: number, maxAttempts: number }}
 */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  baseDelayMs: RETRY_BASE_DELAY_MS,
  maxDelayMs: RETRY_MAX_DELAY_MS,
  maxAttempts: RETRY_MAX_ATTEMPTS,
});

/**
 * Returns the catalog retryability for a known code, otherwise `permanent`.
 * @param {string} code Error code.
 * @returns {'temporary' | 'permanent' | 'user_action_required'}
 */
export function classifyRetryability(code) {
  return getCatalogEntry(code)?.retryability ?? 'permanent';
}

/**
 * True only when the catalog marks the code as auto-retryable (`temporary`).
 * @param {string} code Error code.
 * @returns {boolean}
 */
export function isAutoRetryable(code) {
  return classifyRetryability(code) === 'temporary';
}

/**
 * Computes the next delay with capped exponential backoff and full jitter.
 * Delay = random(0, min(maxDelay, base * 2^attempt)).
 *
 * @param {number} attempt Zero-based attempt index (0 = first retry after failure).
 * @param {{ baseDelayMs?: number, maxDelayMs?: number }} [policy] Optional overrides.
 * @param {() => number} [randomFn] Random in [0, 1); injectable for tests.
 * @returns {number} Delay in milliseconds.
 */
export function computeRetryDelayMs(attempt, policy = {}, randomFn = Math.random) {
  const baseDelayMs = policy.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = baseDelayMs * 2 ** safeAttempt;
  const ceiling = Math.min(maxDelayMs, exponential);
  const unit = Math.min(1, Math.max(0, randomFn()));
  // Full jitter in [0, ceiling]; clamp so a stubbed random of 1 never exceeds the cap.
  return Math.min(ceiling, Math.floor(unit * (ceiling + 1)));
}
