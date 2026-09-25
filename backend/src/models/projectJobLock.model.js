/**
 * `project_job_locks` — one live writer lock per project so ingest and sync
 * jobs do not run against the same project at the same time.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { PROJECT_JOB_LOCK_SCOPE } from '../worker/worker.constants.js';

const projectJobLockSchema = createBaseSchema({
  // Project whose write work this lock serializes
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Job currently holding the lock
  jobId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Worker process that acquired the lock
  workerId: { type: String, required: true },
  // Lock namespace so only one writer runs per project
  lockScope: { type: String, required: true, default: PROJECT_JOB_LOCK_SCOPE, enum: [PROJECT_JOB_LOCK_SCOPE] },
  // When the lock was taken
  acquiredAt: { type: Date, required: true },
  // When the lock expires if the worker stops heartbeating
  expiresAt: { type: Date, required: true },
});

projectJobLockSchema.index(
  { orgId: 1, projectId: 1, lockScope: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);
projectJobLockSchema.index({ expiresAt: 1 });

export const ProjectJobLock =
  mongoose.models.ProjectJobLock ??
  mongoose.model('ProjectJobLock', projectJobLockSchema, 'project_job_locks');
