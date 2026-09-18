/**
 * In-process per-project CodeGraph writer mutex (queues same-key acquirers).
 * Complements ADR 0022 project_job_locks; does not replace them.
 */

/** @type {Map<string, Promise<void>>} */
const projectWriterTails = new Map();

/**
 * Builds a stable lock key for a tenant project.
 * @param {{ orgId: string, projectId: string }} scope Org + project ids.
 * @returns {string}
 */
export function buildWriterLockKey(scope) {
  return `${String(scope.orgId)}:${String(scope.projectId)}`;
}

/**
 * Acquires the in-process writer lock for a project (FIFO queue).
 * @param {{ orgId: string, projectId: string }} scope Org + project ids.
 * @returns {Promise<() => void>} Release function (call once in finally).
 */
export async function acquireWriter(scope) {
  const key = buildWriterLockKey(scope);
  const previous = projectWriterTails.get(key) ?? Promise.resolve();

  let releaseCurrent = () => {};
  const held = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  const tail = previous.then(() => held);
  projectWriterTails.set(
    key,
    tail.then(
      () => undefined,
      () => undefined,
    ),
  );

  await previous;

  let released = false;
  return function releaseWriter() {
    if (released) {
      return;
    }
    released = true;
    releaseCurrent();
  };
}

/**
 * Test helper — clears all writer lock queues.
 * @returns {void}
 */
export function resetWriterLocksForTests() {
  projectWriterTails.clear();
}
