/**
 * `jobs` — project-scoped background work (ingest, reingest, repo sync) that
 * workers claim, heartbeat, and complete without blocking HTTP handlers.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

export const JOB_DEFAULT_MAX_ATTEMPTS = 5;
export const JOB_STATUS_VALUES = Object.freeze([
  'pending',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
  'retrying',
  'cancelled',
]);
export const JOB_TYPE_VALUES = Object.freeze([
  'ingest',
  'reingest',
  'repo_sync',
  'worker_smoke',
]);
export const FAILURE_CLASS_VALUES = Object.freeze([
  'temporary',
  'permanent',
  'user_action_required',
]);

const stageCheckpointSchema = new mongoose.Schema(
  {
    // Last pipeline stage that finished so a retry can resume
    lastCompletedStage: { type: String, default: null },
    // Opaque resume position inside the current or next stage
    cursor: { type: mongoose.Schema.Types.Mixed, required: false },
    // When this checkpoint was last written
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const progressCountersSchema = new mongoose.Schema(
  {
    // Items the worker finished successfully
    itemsProcessed: { type: Number, required: true, default: 0, min: 0 },
    // Items that failed and were not retried in this run
    itemsFailed: { type: Number, required: true, default: 0, min: 0 },
    // Non-fatal issues recorded while the job ran
    warningCount: { type: Number, required: true, default: 0, min: 0 },
    // Items skipped because they are excluded from processing
    excludedCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const jobSchema = createBaseSchema({
  // Project this background job belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Kind of work (ingest, reingest, repo_sync, worker_smoke)
  jobType: { type: String, enum: JOB_TYPE_VALUES, required: true },
  // Queue/runtime state the worker and API read
  jobStatus: { type: String, enum: JOB_STATUS_VALUES, required: true, default: 'pending' },
  // Source snapshot this job is building or refreshing
  sourceVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Request id tying job rows and events to the originating API call
  correlationId: { type: String, default: null },
  // Worker currently leasing this job
  workerId: { type: String, default: null },
  // How many times a worker has claimed this job
  attempt: { type: Number, required: true, default: 0, min: 0 },
  // Cap on claims before the job is permanently failed
  maxAttempts: { type: Number, required: true, default: JOB_DEFAULT_MAX_ATTEMPTS, min: 1 },
  // Last time the holding worker proved it is still alive
  heartbeatAt: { type: Date, default: null },
  // When another worker may steal the job if the holder is silent
  leaseExpiresAt: { type: Date, default: null },
  // Earliest time a worker should pick up this job
  scheduledAt: { type: Date, required: true, default: () => new Date() },
  // Retryability of the last failure (temporary, permanent, user action)
  failureClass: { type: String, enum: FAILURE_CLASS_VALUES, default: null },
  // Stable machine code for the last failure
  failureCode: { type: String, default: null },
  // Pipeline stage the worker is in right now
  currentStage: { type: String, default: null },
  // Resume point so retries do not redo finished stages
  stageCheckpoint: { type: stageCheckpointSchema, default: null },
  // Running totals shown on job progress
  progressCounters: {
    type: progressCountersSchema,
    required: true,
    default: () => ({
      itemsProcessed: 0,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    }),
  },
  // True when some items succeeded even if the job ended with warnings or failure
  partialSuccess: { type: Boolean, required: true, default: false },
  // When a user asked to cancel this job
  cancelRequestedAt: { type: Date, default: null },
  // User who requested cancel
  cancelRequestedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  // When a user asked to retry this job
  retryRequestedAt: { type: Date, default: null },
  // User who requested retry
  retryRequestedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  // How many user- or system-initiated retries have run
  retryCount: { type: Number, required: true, default: 0, min: 0 },
  // Whether the last retry resumed from checkpoint or started over
  lastRetryMode: { type: String, enum: ['resume', 'full', null], default: null },
  // When a worker actually began executing
  startedAt: { type: Date, default: null },
  // When the job reached a terminal status
  completedAt: { type: Date, default: null },
});

jobSchema.index(
  { orgId: 1, projectId: 1, createdAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
jobSchema.index(
  { orgId: 1, projectId: 1, jobStatus: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
jobSchema.index(
  { orgId: 1, projectId: 1, jobStatus: 1, currentStage: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
jobSchema.index(
  { status: 1, jobStatus: 1, jobType: 1, scheduledAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
jobSchema.index(
  { status: 1, jobStatus: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const Job = mongoose.models.Job ?? mongoose.model('Job', jobSchema, 'jobs');
