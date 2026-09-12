/**
 * JobEvent Mongoose model — append-only progress/history events for a job.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { JOB_EVENT_SEVERITY_VALUES } from './jobs.constants.js';

const jobEventSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  eventCode: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  },
  severity: {
    type: String,
    enum: JOB_EVENT_SEVERITY_VALUES,
    required: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  correlationId: {
    type: String,
    default: null,
  },
});

jobEventSchema.index(
  { orgId: 1, jobId: 1, createdAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const JobEvent =
  mongoose.models.JobEvent ?? mongoose.model('JobEvent', jobEventSchema, 'job_events');
