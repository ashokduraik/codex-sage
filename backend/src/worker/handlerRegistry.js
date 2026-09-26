/**
 * Job-type handler registry — domain modules register before the first poll.
 */

/** @typedef {'project' | 'none'} ExclusiveScope */

/**
 * @typedef {{
 *   type: string,
 *   exclusiveScope: ExclusiveScope,
 *   maxAttempts?: number,
 *   run: (context: object) => Promise<{
 *     result: 'completed' | 'completed_with_warnings',
 *     summary?: object,
 *   }>,
 * }} JobHandlerRegistration
 */

/** @type {Map<string, JobHandlerRegistration>} */
const handlersByType = new Map();

/**
 * Registers a handler for a job type. Must run before the first claim poll.
 * @param {JobHandlerRegistration} registration Handler definition.
 * @throws {Error} When type is missing or already registered.
 */
export function registerJobHandler(registration) {
  if (!registration || typeof registration.type !== 'string' || registration.type.length === 0) {
    throw new Error('registerJobHandler requires a non-empty type');
  }
  if (typeof registration.run !== 'function') {
    throw new Error(`registerJobHandler(${registration.type}): run must be a function`);
  }
  if (registration.exclusiveScope !== 'project' && registration.exclusiveScope !== 'none') {
    throw new Error(
      `registerJobHandler(${registration.type}): exclusiveScope must be 'project' or 'none'`,
    );
  }
  if (handlersByType.has(registration.type)) {
    throw new Error(`Job handler already registered for type: ${registration.type}`);
  }
  handlersByType.set(registration.type, {
    type: registration.type,
    exclusiveScope: registration.exclusiveScope,
    maxAttempts: registration.maxAttempts,
    run: registration.run,
  });
}

/**
 * Looks up a registered handler by job type.
 * @param {string} jobType Job type string.
 * @returns {JobHandlerRegistration | undefined}
 */
export function getJobHandler(jobType) {
  return handlersByType.get(jobType);
}

/**
 * Returns registered job type strings for the claim filter.
 * @returns {string[]}
 */
export function listRegisteredJobTypes() {
  return [...handlersByType.keys()];
}

/**
 * Clears all registrations (unit tests only).
 */
export function clearJobHandlersForTests() {
  handlersByType.clear();
}
