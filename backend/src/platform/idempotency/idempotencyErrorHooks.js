/**
 * Late-bound hooks so `errors.js` does not import Mongoose models at load time.
 */

/**
 * Default replay detector (name check only — no class import).
 * @param {unknown} error Thrown value.
 * @returns {boolean}
 */
function defaultIsReplayError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      /** @type {{ name?: string }} */ (error).name === 'IdempotencyReplay',
  );
}

/** @type {(error: unknown) => boolean} */
let isReplayError = defaultIsReplayError;

/** @type {(request: import('fastify').FastifyRequest) => Promise<void>} */
let releaseOwnedClaim = async () => {};

/**
 * Wires idempotency release / replay detection after the module graph is ready.
 * @param {{
 *   isReplayError: (error: unknown) => boolean,
 *   releaseOwnedClaim: (request: import('fastify').FastifyRequest) => Promise<void>,
 * }} hooks Hook implementations.
 */
export function setIdempotencyErrorHooks(hooks) {
  isReplayError = hooks.isReplayError;
  releaseOwnedClaim = hooks.releaseOwnedClaim;
}

/**
 * Restores default hooks (test helper).
 */
export function resetIdempotencyErrorHooks() {
  isReplayError = defaultIsReplayError;
  releaseOwnedClaim = async () => {};
}

/**
 * True when the thrown value is an idempotency replay signal.
 * @param {unknown} error Thrown value.
 * @returns {boolean}
 */
export function isIdempotencyReplayError(error) {
  return isReplayError(error);
}

/**
 * Releases an owned in-flight claim when present on the request.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {Promise<void>}
 */
export async function releaseIdempotencyClaimOnError(request) {
  await releaseOwnedClaim(request);
}
