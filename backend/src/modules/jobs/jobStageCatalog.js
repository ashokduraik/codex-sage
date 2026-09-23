/**
 * Ordered stage lists and human-readable labels per job type.
 * Shared by the worker, progress projection, and tests so they cannot drift.
 */

/**
 * @typedef {{ stage: string, label: string }} JobStageDefinition
 */

/** Ingest pipeline stages (solution §4.6 S0–S6). */
export const INGEST_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ stage: 'validate_upload', label: 'Source received' }),
  Object.freeze({ stage: 'store_files', label: 'Project files identified' }),
  Object.freeze({ stage: 'exclude_apply', label: 'Exclusions applied' }),
  Object.freeze({ stage: 'materialize_docs', label: 'Documentation analyzed' }),
  Object.freeze({ stage: 'codegraph_update', label: 'Project structure analyzed' }),
  Object.freeze({ stage: 'knowledge_publish', label: 'Project knowledge updated' }),
  Object.freeze({ stage: 'finalize', label: 'Processing finalized' }),
]);

/**
 * Stage definitions keyed by job type.
 * reingest reuses ingest stages. repo_sync has its own short fetch/persist list.
 * @type {Readonly<Record<string, readonly JobStageDefinition[]>>}
 */
export const JOB_STAGE_CATALOG = Object.freeze({
  ingest: INGEST_STAGE_DEFINITIONS,
  reingest: INGEST_STAGE_DEFINITIONS,
  repo_sync: Object.freeze([
    Object.freeze({ stage: 'fetch_remote', label: 'Checking repository' }),
    Object.freeze({ stage: 'persist_source', label: 'Saving source files' }),
    Object.freeze({ stage: 'enqueue_ingest', label: 'Queued for processing' }),
  ]),
  worker_smoke: Object.freeze([
    Object.freeze({ stage: 'smoke_run', label: 'Worker smoke check' }),
  ]),
});

/**
 * Returns the ordered stage definitions for a job type (empty when unknown).
 * @param {string} jobType Job type.
 * @returns {readonly JobStageDefinition[]}
 */
export function listStagesForJobType(jobType) {
  return JOB_STAGE_CATALOG[jobType] ?? Object.freeze([]);
}

/**
 * Returns the label for a stage within a job type, or the stage id as fallback.
 * @param {string} jobType Job type.
 * @param {string} stage Stage id.
 * @returns {string}
 */
export function labelForJobStage(jobType, stage) {
  const found = listStagesForJobType(jobType).find((entry) => entry.stage === stage);
  return found?.label ?? stage;
}
