/**
 * `job_events` — append-only progress and error history for a background job,
 * shown in the job timeline and used for support diagnosis.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
export const JOB_EVENT_SEVERITY_VALUES = Object.freeze(['info', 'warning', 'error']);

const jobEventSchema = createBaseSchema({
  // Project the parent job belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Job this history row describes
  jobId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Stable machine code for the event (stage started, file skipped, and so on)
  eventCode: { type: String, required: true, trim: true, maxlength: 120 },
  // How serious the event is for UI and filtering
  severity: { type: String, enum: JOB_EVENT_SEVERITY_VALUES, required: true },
  // Human-readable progress or error text
  message: { type: String, required: true, trim: true },
  // Extra structured details for this event
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Request id shared with the parent job
  correlationId: { type: String, default: null },
});

jobEventSchema.index(
  { orgId: 1, jobId: 1, createdAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const JobEvent =
  mongoose.models.JobEvent ?? mongoose.model('JobEvent', jobEventSchema, 'job_events');
