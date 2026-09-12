/**
 * Per-job structured child logger with the fixed worker field set.
 */

/**
 * Builds bindings for a job-scoped child logger.
 * @param {{
 *   workerId: string,
 *   jobId: string,
 *   jobType: string,
 *   orgId: string,
 *   projectId: string,
 *   attempt: number,
 *   stage?: string | null,
 *   correlationId?: string | null,
 * }} fields Job context fields.
 * @returns {Record<string, unknown>}
 */
export function buildJobLogBindings(fields) {
  return {
    workerId: fields.workerId,
    jobId: fields.jobId,
    jobType: fields.jobType,
    orgId: fields.orgId,
    projectId: fields.projectId,
    attempt: fields.attempt,
    stage: fields.stage ?? null,
    correlationId: fields.correlationId ?? null,
  };
}

/**
 * Creates a child logger for one in-flight job.
 * Falls back to wrapping a plain log object when `.child` is unavailable (tests).
 * @param {object} parentLog Parent logger (pino or test double).
 * @param {Parameters<typeof buildJobLogBindings>[0]} fields Job bindings.
 * @returns {object} Child logger.
 */
export function createJobLogger(parentLog, fields) {
  const bindings = buildJobLogBindings(fields);
  if (parentLog && typeof parentLog.child === 'function') {
    return parentLog.child(bindings);
  }
  return {
    bindings,
    debug: (obj, msg) => parentLog?.debug?.({ ...bindings, ...(obj ?? {}) }, msg),
    info: (obj, msg) => parentLog?.info?.({ ...bindings, ...(obj ?? {}) }, msg),
    warn: (obj, msg) => parentLog?.warn?.({ ...bindings, ...(obj ?? {}) }, msg),
    error: (obj, msg) => parentLog?.error?.({ ...bindings, ...(obj ?? {}) }, msg),
  };
}
