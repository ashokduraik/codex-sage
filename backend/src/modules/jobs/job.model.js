/**
 * Job Mongoose model — project-scoped background work with worker-ready fields.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import {
  FAILURE_CLASS_VALUES,
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
} from './jobs.constants.js';

const stageCheckpointSchema = new mongoose.Schema(
  {
    lastCompletedStage: {
      type: String,
      default: null,
    },
    cursor: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const progressCountersSchema = new mongoose.Schema(
  {
    itemsProcessed: { type: Number, required: true, default: 0, min: 0 },
    itemsFailed: { type: Number, required: true, default: 0, min: 0 },
    warningCount: { type: Number, required: true, default: 0, min: 0 },
    excludedCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const jobSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  jobType: {
    type: String,
    enum: JOB_TYPE_VALUES,
    required: true,
  },
  jobStatus: {
    type: String,
    enum: JOB_STATUS_VALUES,
    required: true,
    default: 'pending',
  },
  sourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  correlationId: {
    type: String,
    default: null,
  },
  workerId: {
    type: String,
    default: null,
  },
  attempt: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  maxAttempts: {
    type: Number,
    required: true,
    default: JOB_DEFAULT_MAX_ATTEMPTS,
    min: 1,
  },
  heartbeatAt: {
    type: Date,
    default: null,
  },
  leaseExpiresAt: {
    type: Date,
    default: null,
  },
  scheduledAt: {
    type: Date,
    required: true,
    default: () => new Date(),
  },
  failureClass: {
    type: String,
    enum: FAILURE_CLASS_VALUES,
    default: null,
  },
  failureCode: {
    type: String,
    default: null,
  },
  currentStage: {
    type: String,
    default: null,
  },
  stageCheckpoint: {
    type: stageCheckpointSchema,
    default: null,
  },
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
  partialSuccess: {
    type: Boolean,
    required: true,
    default: false,
  },
  cancelRequestedAt: {
    type: Date,
    default: null,
  },
  startedAt: {
    type: Date,
    default: null,
  },
  completedAt: {
    type: Date,
    default: null,
  },
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
  { status: 1, jobStatus: 1, jobType: 1, scheduledAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
jobSchema.index(
  { status: 1, jobStatus: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const Job = mongoose.models.Job ?? mongoose.model('Job', jobSchema, 'jobs');
