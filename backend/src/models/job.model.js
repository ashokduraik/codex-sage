/**
 * `jobs` — one background task for a project (build/rebuild knowledge from source,
 * pull a connected Git repo, or clean aged org data). The HTTP handler only creates this
 * row; a worker picks it up later so the request does not wait minutes.
 * `events[]` is the user-readable timeline for this job.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const JOB_DEFAULT_MAX_ATTEMPTS = 5;
export const JOB_STATUS_VALUES = Object.freeze(['pending', 'running', 'completed', 'completed_with_warnings', 'failed', 'retrying', 'cancelled']);
export const JOB_TYPE_VALUES = Object.freeze([
  'project_knowledge_build',
  'project_knowledge_rebuild',
  'connected_repo_pull',
  'aged_org_data_cleanup',
  'worker_smoke_check',
]);
export const FAILURE_CLASS_VALUES = Object.freeze(['temporary', 'permanent', 'user_action_required']);

/** info = progress, warning = problem but continued, error = failure. */
export const JOB_EVENT_SEVERITY_VALUES = Object.freeze(['info', 'warning', 'error']);

const stageCheckpointSchema = new mongoose.Schema(
  {
    // Last finished step, so a retry can skip work already done
    lastCompletedStage: { type: String, default: null },
    // Position inside the current step (e.g. last file processed)
    cursor: { type: mongoose.Schema.Types.Mixed, required: false },
    // When this resume point was last saved
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const jobEventSchema = new mongoose.Schema({
  // Machine code, e.g. job.enqueued or source.validated
  eventCode: { type: String, required: true, trim: true, maxlength: 120 },
  // info = progress, warning = problem but continued, error = failure
  severity: { type: String, enum: JOB_EVENT_SEVERITY_VALUES, required: true },
  // Text shown in the timeline, e.g. "Source received"
  message: { type: String, required: true, trim: true },
  // Extra details (counts, stage name) — not secrets
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Same request id as the parent job and the original API call
  correlationId: { type: String, default: null },
  // When this line was appended
  createdAt: { type: Date, required: true, default: () => new Date() },
});

const progressCountersSchema = new mongoose.Schema(
  {
    // Files or items finished successfully
    itemsProcessed: { type: Number, required: true, default: 0, min: 0 },
    // Items that failed and were not retried in this run
    itemsFailed: { type: Number, required: true, default: 0, min: 0 },
    // Problems that did not stop the job
    warningCount: { type: Number, required: true, default: 0, min: 0 },
    // Items skipped on purpose (excluded from knowledge)
    excludedCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const jobSchema = createBaseSchema({
  // Project this work is for (Payments API)
  projectId: { type: ObjectId, ref: 'Project', default: null },
  // What to do: project_knowledge_build/rebuild, connected_repo_pull, aged_org_data_cleanup, or worker_smoke_check
  jobType: { type: String, enum: JOB_TYPE_VALUES, required: true },
  // pending → running → completed / failed / cancelled (or retrying)
  jobStatus: { type: String, enum: JOB_STATUS_VALUES, required: true, default: 'pending' },
  // File snapshot this job is building or refreshing
  sourceVersionId: { type: ObjectId, ref: 'SourceVersion', default: null },
  // Same as the API request id; joins this job to logs and audit
  correlationId: { type: String, default: null },
  // Worker process currently running this job
  workerId: { type: String, default: null },
  // How many times a worker has picked this job up
  attempt: { type: Number, required: true, default: 0, min: 0 },
  // After this many picks, the job is permanently failed
  maxAttempts: { type: Number, required: true, default: JOB_DEFAULT_MAX_ATTEMPTS, min: 1 },
  // Last time the running worker said "I am still alive"
  heartbeatAt: { type: Date, default: null },
  // After this time another worker may take the job if this one is silent
  leaseExpiresAt: { type: Date, default: null },
  // Earliest time a worker should start this job
  scheduledAt: { type: Date, required: true, default: () => new Date() },
  // Last failure type: temporary (retry), permanent, or needs a person
  failureClass: { type: String, enum: FAILURE_CLASS_VALUES, default: null },
  // Machine code for the last failure (shown in the UI / logs)
  failureCode: { type: String, default: null },
  // Step the worker is in right now (e.g. parse, index)
  currentStage: { type: String, default: null },
  // Saved progress so a retry does not redo finished steps
  stageCheckpoint: { type: stageCheckpointSchema, default: null },
  // Running totals shown on the job progress screen
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
  // When a user clicked cancel
  cancelRequestedAt: { type: Date, default: null },
  // Who clicked cancel
  cancelRequestedBy: { type: ObjectId, ref: 'User', default: null },
  // When a user clicked retry
  retryRequestedAt: { type: Date, default: null },
  // Who clicked retry
  retryRequestedBy: { type: ObjectId, ref: 'User', default: null },
  // How many retries have run (user or system)
  retryCount: { type: Number, required: true, default: 0, min: 0 },
  // Last retry: resume from the saved checkpoint, or start over (full)
  lastRetryMode: { type: String, enum: ['resume', 'full', null], default: null },
  // When a worker actually started running
  startedAt: { type: Date, default: null },
  // When the job finished (success, failure, or cancel)
  completedAt: { type: Date, default: null },
  // User-readable timeline (stage lines). Append with $push only
  events: { type: [jobEventSchema], required: true, default: () => [] },
});

jobSchema.index({ orgId: 1, projectId: 1, createdAt: -1, _id: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
jobSchema.index({ orgId: 1, projectId: 1, jobStatus: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
jobSchema.index({ orgId: 1, projectId: 1, jobStatus: 1, currentStage: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
jobSchema.index({ status: 1, jobStatus: 1, jobType: 1, scheduledAt: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
jobSchema.index({ status: 1, jobStatus: 1, leaseExpiresAt: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const Job = mongoose.models.Job ?? mongoose.model('Job', jobSchema, 'jobs');
