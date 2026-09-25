/**
 * Project job lock — one live writer lock per project (job-level serialization).
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { PROJECT_JOB_LOCK_SCOPE } from '../worker/worker.constants.js';

const projectJobLockSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  workerId: {
    type: String,
    required: true,
  },
  lockScope: {
    type: String,
    required: true,
    default: PROJECT_JOB_LOCK_SCOPE,
    enum: [PROJECT_JOB_LOCK_SCOPE],
  },
  acquiredAt: {
    type: Date,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
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
