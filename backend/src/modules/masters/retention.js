/**
 * masters/retention.js — scheduled soft-delete of aged ingest-related data.
 *
 * One `retention` job per org (`projectId` null). Rules are named constants only
 * (no PATCH). Soft-delete `status: 'D'` — never hard-delete GridFS bytes here.
 */
import { AuditEvent } from '../../models/audit.model.js';
import { Conversation } from '../../models/conversations.model.js';
import { Job } from '../../models/job.model.js';
import { KnowledgeVersion } from '../../models/knowledgeVersion.model.js';
import { Message } from '../../models/messages.model.js';
import { Notification } from '../../models/notification.model.js';
import { Organization } from '../../models/organization.model.js';
import { Project } from '../../models/projects.model.js';
import { SourceFile } from '../../models/sourceFile.model.js';
import { SourceVersion } from '../../models/sourceVersion.model.js';
import { ProjectActivity } from '../../models/projectActivity.model.js';
import { includeDeleted, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { insertPendingJob } from './jobs.helper.js';

/** Ready source versions kept per project. */
export const RETENTION_READY_SOURCE_VERSIONS_KEEP = 3;

/** Terminal jobs older than this are soft-deleted. */
export const RETENTION_JOB_DAYS = 180;

/** Unread notifications older than this are soft-deleted. */
export const RETENTION_NOTIFICATION_DAYS = 90;

/** Read notifications older than this after readAt are soft-deleted. */
export const RETENTION_NOTIFICATION_READ_DAYS = 30;

/** Usage rows older than this are soft-deleted. */
export const RETENTION_USAGE_DAYS = 730;

/** Archived conversations older than this are soft-deleted. */
export const RETENTION_CONVERSATION_DAYS = 365;

/** Audit rows older than this are soft-deleted. */
export const RETENTION_AUDIT_DAYS = 730;

/** How often the worker checks for missing retention jobs. */
export const RETENTION_SCHEDULER_TICK_MS = 60 * 60 * 1000;

/** Terminal job statuses eligible for retention. */
const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'cancelled']);

/**
 * Next UTC midnight after `from`.
 * @param {Date} from Instant.
 * @returns {Date}
 */
export function nextUtcMidnight(from) {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 0, 0, 0, 0));
  return next;
}

/**
 * Soft-deletes matching active rows.
 * @param {import('mongoose').Model} model Target.
 * @param {object} filter Match.
 * @returns {Promise<number>}
 */
async function softDeleteMany(model, filter) {
  const result = await model
    .updateMany({ ...filter, status: ROW_STATUS_ACTIVE }, { $set: { status: ROW_STATUS_DELETED, updatedBy: null, updatedAt: new Date() } })
    .exec();
  return result.modifiedCount ?? 0;
}

/**
 * Applies org retention rules.
 * @param {string} orgId Tenant id.
 * @param {Date} now Instant.
 * @returns {Promise<object>}
 */
export async function runRetentionForOrg(orgId, now = new Date()) {
  const projects = await Project.find({ orgId, status: ROW_STATUS_ACTIVE }).exec();
  let sourceVersions = 0;
  for (const project of projects) {
    sourceVersions += await retainReadySourceVersions(orgId, project);
  }

  const jobCutoff = new Date(now.getTime() - RETENTION_JOB_DAYS * 24 * 60 * 60 * 1000);
  const jobs = await softDeleteMany(Job, {
    orgId,
    jobStatus: { $in: [...TERMINAL_JOB_STATUSES] },
    completedAt: { $lte: jobCutoff },
  });

  const notificationCutoff = new Date(now.getTime() - RETENTION_NOTIFICATION_DAYS * 24 * 60 * 60 * 1000);
  const notificationReadCutoff = new Date(now.getTime() - RETENTION_NOTIFICATION_READ_DAYS * 24 * 60 * 60 * 1000);
  const notifications = await softDeleteMany(Notification, {
    orgId,
    $or: [{ readAt: null, createdAt: { $lte: notificationCutoff } }, { readAt: { $ne: null, $lte: notificationReadCutoff } }],
  });

  const usageCutoff = new Date(now.getTime() - RETENTION_USAGE_DAYS * 24 * 60 * 60 * 1000);
  const projectActivities = await softDeleteMany(ProjectActivity, { orgId, occurredAt: { $lte: usageCutoff } });

  const conversationCutoff = new Date(now.getTime() - RETENTION_CONVERSATION_DAYS * 24 * 60 * 60 * 1000);
  const conversations = await Conversation.find({
    orgId,
    lifecycleStatus: 'archived',
    archivedAt: { $lte: conversationCutoff },
    status: ROW_STATUS_ACTIVE,
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  const conversationIds = conversations.map((row) => row._id);
  if (conversationIds.length > 0) {
    await softDeleteMany(Conversation, { orgId, _id: { $in: conversationIds } });
    await softDeleteMany(Message, { orgId, conversationId: { $in: conversationIds } });
  }

  const auditCutoff = new Date(now.getTime() - RETENTION_AUDIT_DAYS * 24 * 60 * 60 * 1000);
  const auditQuery = includeDeleted(
    AuditEvent.updateMany({ orgId, createdAt: { $lte: auditCutoff }, status: ROW_STATUS_ACTIVE }, { $set: { status: ROW_STATUS_DELETED } }),
  );
  auditQuery.setOptions({ retentionJob: true, includeDeleted: true });
  const auditResult = await auditQuery.exec();

  return {
    sourceVersions,
    jobs,
    notifications,
    projectActivities,
    conversations: conversationIds.length,
    audit: auditResult.modifiedCount ?? 0,
  };

  /**
   * Soft-deletes older ready source versions beyond the keep count.
   * @param {string} orgId Tenant id.
   * @param {object} project Project document.
   * @returns {Promise<number>}
   */
  async function retainReadySourceVersions(orgId, project) {
    const projectId = project._id;
    const ready = await KnowledgeVersion.find({
      orgId,
      projectId,
      publishedHealth: 'ready',
      status: ROW_STATUS_ACTIVE,
    })
      .sort({ publishedAt: -1, _id: -1 })
      .select({ _id: 1, sourceVersionId: 1 })
      .lean()
      .exec();
    const keepIds = new Set();
    if (project.currentKnowledgeVersionId) {
      keepIds.add(String(project.currentKnowledgeVersionId));
    }
    for (const row of ready.slice(0, RETENTION_READY_SOURCE_VERSIONS_KEEP)) {
      keepIds.add(String(row._id));
    }
    const stale = ready.filter((row) => !keepIds.has(String(row._id)));
    if (stale.length === 0) {
      return 0;
    }
    const knowledgeIds = stale.map((row) => row._id);
    const sourceVersionIds = stale.map((row) => row.sourceVersionId).filter(Boolean);
    await softDeleteMany(KnowledgeVersion, { orgId, _id: { $in: knowledgeIds } });
    if (sourceVersionIds.length > 0) {
      await softDeleteMany(SourceVersion, { orgId, _id: { $in: sourceVersionIds } });
      await softDeleteMany(SourceFile, { orgId, sourceVersionId: { $in: sourceVersionIds } });
    }
    return stale.length;
  }
}

/**
 * Worker handler for jobType retention.
 */
export const retentionHandlerRegistration = {
  type: 'retention',
  exclusiveScope: /** @type {'none'} */ ('none'),
  run: runRetentionJob,
};

/**
 * Runs retention for the job's organization.
 * @param {object} workerContext Handler context.
 * @returns {Promise<{ result: 'completed', summary: object }>}
 */
export async function runRetentionJob(workerContext) {
  const job = workerContext.job;
  const summary = await runRetentionForOrg(String(job.orgId), new Date());
  return { result: 'completed', summary };
}

/**
 * Enqueues a pending retention job per org when none is active.
 * @param {{
 *   log?: { error?: Function, info?: Function },
 *   now?: Date,
 * }} [input] Seams.
 * @returns {Promise<{ enqueued: number, skipped: number }>}
 */
export async function enqueueDueRetentionJobs(input = {}) {
  const now = input.now ?? new Date();
  const orgs = await Organization.find({ status: ROW_STATUS_ACTIVE }).select({ _id: 1 }).lean().exec();
  let enqueued = 0;
  let skipped = 0;
  for (const org of orgs) {
    const orgId = String(org._id);
    try {
      const existing = await Job.findOne({
        orgId,
        jobType: 'retention',
        jobStatus: { $in: ['pending', 'running', 'retrying'] },
        status: ROW_STATUS_ACTIVE,
      })
        .select({ _id: 1 })
        .lean()
        .exec();
      if (existing) {
        skipped += 1;
        continue;
      }
      await insertPendingJob({
        orgId,
        projectId: null,
        jobType: 'retention',
        createdBy: null,
        scheduledAt: now,
      });
      enqueued += 1;
    } catch (err) {
      skipped += 1;
      input.log?.error?.({ orgId, errName: err instanceof Error ? err.name : 'Error' }, 'retention enqueue failed');
    }
  }
  return { enqueued, skipped };
}
