/**
 * Soft-deletes aged org data (old jobs, notifications, chats, audit, excess knowledge)
 * and cascades soft-delete for already-deleted projects. Worker-owned: schedule enqueues
 * one job per org; this file runs the cleanup using each org's retentionPolicy.
 */
import { Job } from '../models/job.model.js';
import { AuditEvent } from '../models/audit.model.js';
import { Message } from '../models/messages.model.js';
import { Project } from '../models/projects.model.js';
import { caughtErrorFields } from '../platform/errors.js';
import { SourceFile } from '../models/sourceFile.model.js';
import { Notification } from '../models/notification.model.js';
import { Organization } from '../models/organization.model.js';
import { Conversation } from '../models/conversations.model.js';
import { SourceVersion } from '../models/sourceVersion.model.js';
import { ChatCheckpoint } from '../models/chatCheckpoint.model.js';
import { DocumentSection } from '../models/documentSection.model.js';
import { insertPendingJob } from '../modules/masters/jobs.helper.js';
import { ProjectActivity } from '../models/projectActivity.model.js';
import { KnowledgeVersion } from '../models/knowledgeVersion.model.js';
import { markGridFsFilesOrphaned } from '../modules/knowledge/sources.js';
import { RepositoryConnection } from '../models/repositoryConnection.model.js';
import { includeDeleted, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../platform/data/index.js';
import { RETENTION_POLICY_DEFAULTS, resolveEffectiveRetentionPolicy } from '../modules/masters/organizations.js';

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.readySourceVersionsKeep — kept for existing imports. */
export const RETENTION_READY_SOURCE_VERSIONS_KEEP = RETENTION_POLICY_DEFAULTS.readySourceVersionsKeep;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.jobDays */
export const RETENTION_JOB_DAYS = RETENTION_POLICY_DEFAULTS.jobDays;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.notificationDays */
export const RETENTION_NOTIFICATION_DAYS = RETENTION_POLICY_DEFAULTS.notificationDays;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.notificationReadDays */
export const RETENTION_NOTIFICATION_READ_DAYS = RETENTION_POLICY_DEFAULTS.notificationReadDays;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.usageDays */
export const RETENTION_USAGE_DAYS = RETENTION_POLICY_DEFAULTS.usageDays;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.conversationDays */
export const RETENTION_CONVERSATION_DAYS = RETENTION_POLICY_DEFAULTS.conversationDays;

/** @deprecated Prefer RETENTION_POLICY_DEFAULTS.auditDays */
export const RETENTION_AUDIT_DAYS = RETENTION_POLICY_DEFAULTS.auditDays;

/** How often the worker checks for missing cleanup jobs. */
export const AGED_ORG_DATA_CLEANUP_SCHEDULER_TICK_MS = 60 * 60 * 1000;

/** Terminal job statuses eligible for age-based cleanup (not cascade). */
const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'cancelled']);

/**
 * Soft-deletes aged rows for one org (source versions, jobs, notifications, chats, audit)
 * and cascades children of soft-deleted projects.
 * @param {string} orgId Tenant id.
 * @param {Date} [now] Instant used for age cutoffs.
 * @returns {Promise<object>} Counts soft-deleted per resource.
 */
export async function applyAgedOrgDataCleanupForOrg(orgId, now = new Date()) {
  const organization = await Organization.findById(orgId).lean().exec();
  const policy = resolveEffectiveRetentionPolicy(organization?.retentionPolicy);

  const activeProjects = await Project.find({ orgId, status: ROW_STATUS_ACTIVE }).exec();
  let sourceVersions = 0;
  for (const project of activeProjects) {
    sourceVersions += await softDeleteExcessReadySourceVersions(orgId, project, policy.readySourceVersionsKeep);
  }

  const jobCutoff = daysAgo(now, policy.jobDays);
  const jobs = await softDeleteManyActive(Job, {
    orgId,
    jobStatus: { $in: [...TERMINAL_JOB_STATUSES] },
    completedAt: { $lte: jobCutoff },
  });

  const notificationCutoff = daysAgo(now, policy.notificationDays);
  const notificationReadCutoff = daysAgo(now, policy.notificationReadDays);
  const notifications = await softDeleteManyActive(Notification, {
    orgId,
    $or: [{ readAt: null, createdAt: { $lte: notificationCutoff } }, { readAt: { $ne: null, $lte: notificationReadCutoff } }],
  });

  const usageCutoff = daysAgo(now, policy.usageDays);
  const projectActivities = await softDeleteManyActive(ProjectActivity, { orgId, occurredAt: { $lte: usageCutoff } });

  const conversationCutoff = daysAgo(now, policy.conversationDays);
  const agedConversations = await Conversation.find({
    orgId,
    lifecycleStatus: 'archived',
    archivedAt: { $lte: conversationCutoff },
    status: ROW_STATUS_ACTIVE,
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  const agedConversationIds = agedConversations.map((row) => row._id);
  if (agedConversationIds.length > 0) {
    await softDeleteManyActive(Conversation, { orgId, _id: { $in: agedConversationIds } });
    await softDeleteManyActive(Message, { orgId, conversationId: { $in: agedConversationIds } });
    await softDeleteChatCheckpointsForConversations(orgId, agedConversationIds);
  }

  const auditCutoff = daysAgo(now, policy.auditDays);
  const auditQuery = includeDeleted(
    AuditEvent.updateMany({ orgId, createdAt: { $lte: auditCutoff }, status: ROW_STATUS_ACTIVE }, { $set: { status: ROW_STATUS_DELETED } }),
  );
  auditQuery.setOptions({ retentionJob: true, includeDeleted: true });
  const auditResult = await auditQuery.exec();

  const cascade = await cascadeSoftDeletedProjects(orgId);

  return {
    sourceVersions,
    jobs,
    notifications,
    projectActivities,
    conversations: agedConversationIds.length,
    audit: auditResult.modifiedCount ?? 0,
    cascade,
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
   * @param {number} keepCount Ready versions to retain.
   * @returns {Promise<number>} Versions soft-deleted.
   */
  async function softDeleteExcessReadySourceVersions(tenantOrgId, project, keepCount) {
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
    for (const row of ready.slice(0, keepCount)) {
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
      const files = await SourceFile.find({
        orgId: tenantOrgId,
        sourceVersionId: { $in: sourceVersionIds },
        status: ROW_STATUS_ACTIVE,
      })
        .select({ gridFsId: 1 })
        .lean()
        .exec();
      await softDeleteManyActive(SourceFile, { orgId: tenantOrgId, sourceVersionId: { $in: sourceVersionIds } });
      await softDeleteManyActive(DocumentSection, { orgId: tenantOrgId, sourceVersionId: { $in: sourceVersionIds } });
      const gridFsIds = files.map((row) => row.gridFsId).filter(Boolean);
      await markGridFsFilesOrphaned(gridFsIds);
    }
    return stale.length;
  }
}

/**
 * Soft-deletes remaining active children of soft-deleted projects (audit never touched).
 * @param {string} orgId Tenant id.
 * @returns {Promise<object>} Per-resource cascade counts.
 */
async function cascadeSoftDeletedProjects(orgId) {
  const deletedProjects = await includeDeleted(Project.find({ orgId, status: ROW_STATUS_DELETED }))
    .select({ _id: 1 })
    .lean()
    .exec();
  /** @type {Record<string, number>} */
  const totals = {
    sourceVersions: 0,
    sourceFiles: 0,
    knowledgeVersions: 0,
    documentSections: 0,
    repositoryConnections: 0,
    conversations: 0,
    messages: 0,
    jobs: 0,
    notifications: 0,
    projectActivities: 0,
    chatCheckpoints: 0,
  };
  for (const project of deletedProjects) {
    const projectId = project._id;
    const counts = await cascadeOneDeletedProject(orgId, projectId);
    for (const [key, value] of Object.entries(counts)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

/**
 * Cascades soft-delete for one deleted project's children.
 * @param {string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId} projectId Project id.
 * @returns {Promise<Record<string, number>>}
 */
async function cascadeOneDeletedProject(orgId, projectId) {
  const files = await SourceFile.find({ orgId, projectId, status: ROW_STATUS_ACTIVE }).select({ gridFsId: 1 }).lean().exec();
  const sourceFiles = await softDeleteScoped(SourceFile, { orgId, projectId });
  const gridFsIds = files.map((row) => row.gridFsId).filter(Boolean);
  await markGridFsFilesOrphaned(gridFsIds);

  const conversations = await Conversation.find({ orgId, projectId, status: ROW_STATUS_ACTIVE }).select({ _id: 1 }).lean().exec();
  const conversationIds = conversations.map((row) => row._id);
  const conversationCount = await softDeleteScoped(Conversation, { orgId, projectId });
  let messages = 0;
  let chatCheckpoints = 0;
  if (conversationIds.length > 0) {
    messages = await softDeleteScoped(Message, { orgId, conversationId: { $in: conversationIds } });
    chatCheckpoints = await softDeleteChatCheckpointsForConversations(orgId, conversationIds);
  }

  return {
    sourceVersions: await softDeleteScoped(SourceVersion, { orgId, projectId }),
    sourceFiles,
    knowledgeVersions: await softDeleteScoped(KnowledgeVersion, { orgId, projectId }),
    documentSections: await softDeleteScoped(DocumentSection, { orgId, projectId }),
    repositoryConnections: await softDeleteScoped(RepositoryConnection, { orgId, projectId }),
    conversations: conversationCount,
    messages,
    jobs: await softDeleteScoped(Job, { orgId, projectId }),
    notifications: await softDeleteScoped(Notification, { orgId, 'resourceRef.projectId': projectId }),
    projectActivities: await softDeleteScoped(ProjectActivity, { orgId, projectId }),
    chatCheckpoints,
  };
}

/**
 * Soft-deletes active rows matching filter.
 * @param {import('mongoose').Model} model Collection model.
 * @param {object} filter Match filter.
 * @returns {Promise<number>}
 */
async function softDeleteScoped(model, filter) {
  const result = await model
    .updateMany({ ...filter, status: ROW_STATUS_ACTIVE }, { $set: { status: ROW_STATUS_DELETED, updatedBy: null, updatedAt: new Date() } })
    .exec();
  return result.modifiedCount ?? 0;
}

/**
 * Soft-deletes LangGraph checkpoints whose threadId belongs to the given conversations.
 * @param {string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId[]} conversationIds Conversation ids.
 * @returns {Promise<number>} Rows soft-deleted.
 */
async function softDeleteChatCheckpointsForConversations(orgId, conversationIds) {
  if (conversationIds.length === 0) {
    return 0;
  }
  const prefixes = conversationIds.map((id) => `${String(orgId)}:${String(id)}:`);
  const escaped = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const result = await ChatCheckpoint.updateMany(
    {
      orgId,
      status: ROW_STATUS_ACTIVE,
      threadId: { $regex: `^(${escaped.join('|')})` },
    },
    { $set: { status: ROW_STATUS_DELETED, updatedBy: null, updatedAt: new Date() } },
  ).exec();
  return result.modifiedCount ?? 0;
}

/**
 * @param {Date} now Reference instant.
 * @param {number} days Days to subtract.
 * @returns {Date}
 */
function daysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
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
