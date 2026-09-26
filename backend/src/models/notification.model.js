/**
 * `notifications` — one in-app inbox row per recipient for a project event.
 * Example: Alice gets “Knowledge update completed” after ingest finishes.
 * There is no email or SSE in this slice; the header bell polls this collection.
 * Soft-delete (`status: 'D'`) is retention-only — users mark rows read, they do not delete them.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Allowed inbox types. No admin-broadcast or approval types in this slice. */
export const NOTIFICATION_TYPE_VALUES = Object.freeze([
  'knowledge.completed',
  'knowledge.failed',
  'repo.sync.completed',
  'repo.sync.failed',
  'processing.attention',
]);

const resourceRefSchema = new mongoose.Schema(
  {
    // Project the event belongs to (Payments API) — used to deep-link the row
    projectId: { type: ObjectId, ref: 'Project', required: true },
    // Job that finished or needs attention; null when the event is not job-scoped
    jobId: { type: ObjectId, ref: 'Job', default: null },
    // Source snapshot the job processed; null for repo-sync-only outcomes
    sourceVersionId: { type: ObjectId, ref: 'SourceVersion', default: null },
  },
  { _id: false },
);

const notificationSchema = createBaseSchema({
  // Inbox owner (Alice). Fan-out writes one row per eligible user.
  userId: { type: ObjectId, ref: 'User', required: true },
  // Which product event this row is (knowledge finished, repo sync failed, …)
  type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true },
  // Short heading shown in the bell, e.g. "Knowledge update completed"
  title: { type: String, required: true, trim: true, maxlength: 200 },
  // One-line body in user language — never ids, tokens, or stack traces
  body: { type: String, required: true, trim: true, maxlength: 500 },
  // Where to navigate when Alice opens the row
  resourceRef: { type: resourceRefSchema, required: true },
  // When Alice marked it read; null means unread
  readAt: { type: Date, default: null },
  // Idempotency per user, e.g. "{jobId}:knowledge.completed"
  dedupeKey: { type: String, required: true, trim: true },
});

// Newest first for the bell list
notificationSchema.index({ orgId: 1, userId: 1, status: 1, createdAt: -1, _id: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
// One active row per user + event so a retry does not duplicate the inbox
notificationSchema.index({ orgId: 1, userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const Notification = mongoose.models.Notification ?? mongoose.model('Notification', notificationSchema);
