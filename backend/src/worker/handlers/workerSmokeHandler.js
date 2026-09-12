/**
 * Smoke handler — completes immediately for Phase 21 verification.
 * @param {object} context Handler context from the worker runtime.
 * @returns {Promise<{ result: 'completed', summary: object }>}
 */
export async function runWorkerSmokeHandler(context) {
  const checkpoint = context.stageCheckpoint;
  if (checkpoint?.lastCompletedStage === 'smoke_done') {
    context.log?.info?.({}, 'worker_smoke resumed; already complete');
    return { result: 'completed', summary: { resumed: true } };
  }

  await context.saveCheckpoint({
    lastCompletedStage: 'smoke_done',
  });
  return { result: 'completed', summary: { smoke: true } };
}

/**
 * Registration descriptor for the smoke handler.
 */
export const workerSmokeHandlerRegistration = {
  type: 'worker_smoke',
  exclusiveScope: /** @type {'none'} */ ('none'),
  maxAttempts: 3,
  run: runWorkerSmokeHandler,
};
