/**
 * `project_job_locks` — only one ingest or sync job may write a project
 * at a time. When a worker starts ingest for Payments API, it takes
 * this lock. Another sync waits until the lock is released or expires.
 */
import mongoose from 'mongoose';
import { PROJECT_JOB_LOCK_SCOPE } from '../worker/workerConfig.js';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const projectJobLockSchema = createBaseSchema({
  // Project that must have only one writer (Payments API)
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Job currently writing that project
  jobId: { type: ObjectId, ref: 'Job', required: true },
  // Worker process that took the lock
  workerId: { type: String, required: true },
  // Always the project-writer scope; kept so only one lock exists per project
  lockScope: { type: String, required: true, default: PROJECT_JOB_LOCK_SCOPE, enum: [PROJECT_JOB_LOCK_SCOPE] },
  // When the lock was taken
  acquiredAt: { type: Date, required: true },
  // When another job may take over if this worker goes silent
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

export const ProjectJobLock = mongoose.models.ProjectJobLock ?? mongoose.model('ProjectJobLock', projectJobLockSchema, 'project_job_locks');
