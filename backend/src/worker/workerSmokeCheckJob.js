/**
 * Worker health-check job — completes immediately to verify claim/finish.
 */

/**
 * Runs the worker_smoke_check job.
 * @param {object} context Handler context from the worker schedule.
 * @returns {Promise<{ result: 'completed', summary: object }>}
 */
export async function runWorkerSmokeCheckJob(context) {
  const checkpoint = context.stageCheckpoint;
  if (checkpoint?.lastCompletedStage === 'smoke_done') {
    context.log?.info?.({}, 'worker_smoke_check resumed; already complete');
    return { result: 'completed', summary: { resumed: true } };
  }

  await context.saveCheckpoint({
    lastCompletedStage: 'smoke_done',
  });
  return { result: 'completed', summary: { smoke: true } };
}

/** Registration for jobType worker_smoke_check. */
export const workerSmokeCheckHandlerRegistration = {
  type: 'worker_smoke_check',
  exclusiveScope: /** @type {'none'} */ ('none'),
  maxAttempts: 3,
  run: runWorkerSmokeCheckJob,
};
