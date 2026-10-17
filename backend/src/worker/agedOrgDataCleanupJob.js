/**
 * Soft-deletes aged org data (old jobs, notifications, chats, audit, excess knowledge).
 * Worker-owned: schedule enqueues one job per org; this file runs the cleanup.
 */
import { Job } from '../models/job.model.js';
import { Project } from '../models/projects.model.js';
import { Message } from '../models/messages.model.js';
import { AuditEvent } from '../models/audit.model.js';
import { SourceFile } from '../models/sourceFile.model.js';
import { caughtErrorFields } from '../platform/errors.js';
import { Notification } from '../models/notification.model.js';
import { Organization } from '../models/organization.model.js';
import { Conversation } from '../models/conversations.model.js';
import { SourceVersion } from '../models/sourceVersion.model.js';
import { ProjectActivity } from '../models/projectActivity.model.js';
import { KnowledgeVersion } from '../models/knowledgeVersion.model.js';
import { insertPendingJob } from '../modules/masters/jobs.helper.js';
import { includeDeleted, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../platform/data/index.js';

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

/** How often the worker checks for missing cleanup jobs. */
export const AGED_ORG_DATA_CLEANUP_SCHEDULER_TICK_MS = 60 * 60 * 1000;

/** Terminal job statuses eligible for cleanup. */
const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'cancelled']);

/**
 * Soft-deletes aged rows for one org (source versions, jobs, notifications, chats, audit).
 * @param {string} orgId Tenant id.
 * @param {Date} [now] Instant used for age cutoffs.
 * @returns {Promise<object>} Counts soft-deleted per resource.
 */
export async function applyAgedOrgDataCleanupForOrg(orgId, now = new Date()) {
  const projects = await Project.find({ orgId, status: ROW_STATUS_ACTIVE }).exec();
  let sourceVersions = 0;
  for (const project of projects) {
    sourceVersions += await softDeleteExcessReadySourceVersions(orgId, project);
  }

  const jobCutoff = new Date(now.getTime() - RETENTION_JOB_DAYS * 24 * 60 * 60 * 1000);
  const jobs = await softDeleteManyActive(Job, {
    orgId,
    jobStatus: { $in: [...TERMINAL_JOB_STATUSES] },
    completedAt: { $lte: jobCutoff },
  });

  const notificationCutoff = new Date(now.getTime() - RETENTION_NOTIFICATION_DAYS * 24 * 60 * 60 * 1000);
  const notificationReadCutoff = new Date(now.getTime() - RETENTION_NOTIFICATION_READ_DAYS * 24 * 60 * 60 * 1000);
  const notifications = await softDeleteManyActive(Notification, {
    orgId,
    $or: [{ readAt: null, createdAt: { $lte: notificationCutoff } }, { readAt: { $ne: null, $lte: notificationReadCutoff } }],
  });

  const usageCutoff = new Date(now.getTime() - RETENTION_USAGE_DAYS * 24 * 60 * 60 * 1000);
  const projectActivities = await softDeleteManyActive(ProjectActivity, { orgId, occurredAt: { $lte: usageCutoff } });

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
    await softDeleteManyActive(Conversation, { orgId, _id: { $in: conversationIds } });
    await softDeleteManyActive(Message, { orgId, conversationId: { $in: conversationIds } });
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
   * Soft-deletes matching active rows.
   * @param {import('mongoose').Model} model Target collection model.
   * @param {object} filter Match filter (status A applied here).
   * @returns {Promise<number>} Rows soft-deleted.
   */
  async function softDeleteManyActive(model, filter) {
    const result = await model
      .updateMany({ ...filter, status: ROW_STATUS_ACTIVE }, { $set: { status: ROW_STATUS_DELETED, updatedBy: null, updatedAt: new Date() } })
      .exec();
    return result.modifiedCount ?? 0;
  }

  /**
   * Soft-deletes older ready source versions beyond the keep count for one project.
   * @param {string} tenantOrgId Tenant id.
   * @param {object} project Project document.
   * @returns {Promise<number>} Versions soft-deleted.
   */
  async function softDeleteExcessReadySourceVersions(tenantOrgId, project) {
    const projectId = project._id;
    const ready = await KnowledgeVersion.find({
      orgId: tenantOrgId,
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
    await softDeleteManyActive(KnowledgeVersion, { orgId: tenantOrgId, _id: { $in: knowledgeIds } });
    if (sourceVersionIds.length > 0) {
      await softDeleteManyActive(SourceVersion, { orgId: tenantOrgId, _id: { $in: sourceVersionIds } });
      await softDeleteManyActive(SourceFile, { orgId: tenantOrgId, sourceVersionId: { $in: sourceVersionIds } });
    }
    return stale.length;
  }
}

/**
 * Runs aged-org-data cleanup for the claimed job's organization.
 * @param {object} workerContext Handler context.
 * @returns {Promise<{ result: 'completed', summary: object }>}
 */
export async function runAgedOrgDataCleanupJob(workerContext) {
  const summary = await applyAgedOrgDataCleanupForOrg(String(workerContext.job.orgId), new Date());
  return { result: 'completed', summary };
}

/**
 * Enqueues a pending cleanup job per active org when none is already active.
 * @param {{
 *   log?: { error?: Function, info?: Function },
 *   now?: Date,
 * }} [input] Optional log and clock for the tick.
 * @returns {Promise<{ enqueued: number, skipped: number }>}
 */
export async function enqueueDueAgedOrgDataCleanupJobs(input = {}) {
  const now = input.now ?? new Date();
  const orgs = await Organization.find({ status: ROW_STATUS_ACTIVE }).select({ _id: 1 }).lean().exec();
  let enqueued = 0;
  let skipped = 0;
  for (const org of orgs) {
    const orgId = String(org._id);
    try {
      const existing = await Job.findOne({
        orgId,
        jobType: 'aged_org_data_cleanup',
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
        jobType: 'aged_org_data_cleanup',
        createdBy: null,
        scheduledAt: now,
      });
      enqueued += 1;
    } catch (err) {
      skipped += 1;
      input.log?.error?.({ orgId, ...caughtErrorFields(err) }, 'aged_org_data_cleanup enqueue failed');
    }
  }
  return { enqueued, skipped };
}

/** Registration for jobType aged_org_data_cleanup. */
export const agedOrgDataCleanupHandlerRegistration = {
  type: 'aged_org_data_cleanup',
  exclusiveScope: /** @type {'none'} */ ('none'),
  run: runAgedOrgDataCleanupJob,
};
