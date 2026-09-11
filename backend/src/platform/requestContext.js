/**
 * AsyncLocalStorage request context for correlation and (later) tenant fields.
 * HTTP hooks enter the store; services read without threading ids through every signature.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Prefix of the generated correlation reference (backend §105). */
export const CORRELATION_ID_PREFIX = 'REQ';

/**
 * @typedef {object} RequestContext
 * @property {string} correlationId
 * @property {string} [organizationId] Populated in phase 07.
 * @property {string} [userId] Populated in phase 07.
 */

/** @type {AsyncLocalStorage<RequestContext>} */
const storage = new AsyncLocalStorage();

/**
 * Generates a server-side correlation id: `REQ-` + 32 hex (UUID without dashes).
 * Client-supplied ids are never honoured.
 * @returns {string}
 */
export function generateCorrelationId() {
  return `${CORRELATION_ID_PREFIX}-${randomUUID().replace(/-/g, '')}`;
}

/**
 * Runs `fn` inside a request context store.
 * @template T
 * @param {RequestContext} context Context for this async scope.
 * @param {() => T} fn Work to run inside the store.
 * @returns {T}
 */
export function runWithRequestContext(context, fn) {
  return storage.run(context, fn);
}

/**
 * Returns the current request context, or `undefined` outside a request/job scope.
 * @returns {RequestContext | undefined}
 */
export function getRequestContext() {
  return storage.getStore();
}

/**
 * Convenience: current correlation id, or `undefined` outside a scoped run.
 * @returns {string | undefined}
 */
export function getCorrelationId() {
  return storage.getStore()?.correlationId;
}
