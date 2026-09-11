/**
 * Named constants for Idempotency-Key handling (not env — D13).
 */

/** Minimum accepted Idempotency-Key length. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** Maximum accepted Idempotency-Key length. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Allowed characters for Idempotency-Key values. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** How long an idempotency record remains usable for replay. */
export const IDEMPOTENCY_RECORD_TTL_MS = 86_400_000;

/** How long a duplicate waiter polls for the first writer's result. */
export const IDEMPOTENCY_WAIT_MS = 5_000;

/** Poll interval while waiting for an in-flight twin. */
export const IDEMPOTENCY_POLL_INTERVAL_MS = 100;

/** Max UTF-8 byte size of a stored replay body. */
export const IDEMPOTENCY_BODY_MAX_BYTES = 65_536;

/** HTTP header name (Fastify lowercases incoming headers). */
export const IDEMPOTENCY_HEADER_NAME = 'idempotency-key';
