/**
 * masters/notifications.js — in-app inbox for ingest and repo-sync outcomes.
 *
 * Owns emit (best-effort, after a job is already terminal), list, mark-read,
 * and mark-all-read. Recipients are resolved from project members + all-access
 * users who hold the type's permission. Duplicate `{ orgId, userId, dedupeKey }`
 * inserts are ignored so a worker retry does not spam the bell.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { User } from '../../models/user.model.js';
import { findProjectById } from './projects.helper.js';
import { hasRequiredPermissions } from '../access/index.js';
import { listProjectMembers, resolveProjectPermissions } from './projectMembers.js';
import { ApiError, apiErrorFromCaught, caughtErrorFields } from '../../platform/errors.js';
import { Notification, NOTIFICATION_TYPE_VALUES } from '../../models/notification.model.js';
import { assertOrgId, decodeCursor, encodeCursor, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

/** Default list page size. */
export const NOTIFICATION_LIST_PAGE_SIZE_DEFAULT = 20;

/** Hard cap on list limit. */
export const NOTIFICATION_LIST_PAGE_SIZE_MAX = 100;

/** Stored title max length. */
export const NOTIFICATION_TITLE_MAX_CHARS = 200;

/** Stored body max length. */
export const NOTIFICATION_BODY_MAX_CHARS = 500;

/** English titles keyed by notification type. */
const NOTIFICATION_TITLES = Object.freeze({
  'knowledge.completed': 'Knowledge update completed',
  'knowledge.failed': 'Knowledge update failed',
  'repo.sync.completed': 'Repository sync completed',
  'repo.sync.failed': 'Repository sync failed',
  'processing.attention': 'Processing needs attention',
});

/** English body templates keyed by notification type. */
const NOTIFICATION_BODIES = Object.freeze({
  'knowledge.completed': 'A project finished processing.',
  'knowledge.failed': 'A project failed while processing knowledge.',
  'repo.sync.completed': 'A repository sync finished.',
  'repo.sync.failed': 'A repository sync failed.',
  'processing.attention': 'Processing needs a user action.',
});

/**
 * Filters candidate users by a project permission.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {string} requiredPermission Permission key.
 * @param {string[]} extraUserIds Always-included ids (still must have project access).
 * @returns {Promise<string[]>}
 */
export async function listNotificationRecipientUserIds(orgId, projectId, requiredPermission, extraUserIds = []) {
  const candidates = new Set(await listCandidateRecipientUserIds(orgId, projectId));
  for (const extra of extraUserIds) {
    if (extra) {
      candidates.add(String(extra));
    }
  }
  /** @type {string[]} */
  const recipients = [];
  for (const userId of candidates) {
    const resolved = await resolveProjectPermissions(orgId, userId, projectId);
    if (resolved.kind !== 'OK') {
      continue;
    }
    if (hasRequiredPermissions(resolved.permissions, [requiredPermission], 'all')) {
      recipients.push(userId);
    }
  }
  return recipients;

  /**
   * Lists candidate recipient user ids for a project (members + all-access users).
   * @param {string} candidateOrgId Tenant id.
   * @param {string} candidateProjectId Project id.
   * @returns {Promise<string[]>}
   */
  async function listCandidateRecipientUserIds(candidateOrgId, candidateProjectId) {
    const members = await listProjectMembers(candidateOrgId, candidateProjectId);
    const memberIds = members.map((member) => String(member.userId));
    const allAccess = await User.find({
      orgId: candidateOrgId,
      projectAccessMode: 'all',
      userStatus: 'active',
    })
      .select({ _id: 1 })
      .lean()
      .exec();
    const ids = new Set(memberIds);
    for (const row of allAccess) {
      ids.add(String(row._id));
    }
    return [...ids];
  }
}

/**
 * Permission required to receive each notification type.
 * @param {string} type Notification type.
 * @returns {string}
 */
export function permissionForNotificationType(type) {
  if (type === 'processing.attention') {
    return 'knowledge.trigger';
  }
  if (type.startsWith('repo.sync.')) {
    return 'projects.view';
  }
  return 'knowledge.view';
}

/**
 * Fan-out a project notification to eligible recipients.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   type: string,
 *   jobId?: string | null,
 *   sourceVersionId?: string | null,
 *   extraUserIds?: string[],
 *   log?: { error?: Function },
 * }} input Emit inputs.
 * @returns {Promise<number>} Rows attempted (including existing duplicates).
 */
export async function emitProjectNotification(input) {
  try {
    assertOrgId(input.orgId);
    if (!NOTIFICATION_TYPE_VALUES.includes(input.type)) {
      input.log?.error?.({ type: input.type }, 'unknown notification type skipped');
      return 0;
    }
    const project = await findProjectById(input.orgId, input.projectId);
    if (!project) {
      return 0;
    }
    const required = permissionForNotificationType(input.type);
    const recipients = await listNotificationRecipientUserIds(input.orgId, input.projectId, required, input.extraUserIds ?? []);
    const title = NOTIFICATION_TITLES[input.type];
    const body = buildNotificationBody(input.type, project.name ?? null);
    const jobId = input.jobId ? new mongoose.Types.ObjectId(String(input.jobId)) : null;
    const sourceVersionId = input.sourceVersionId ? new mongoose.Types.ObjectId(String(input.sourceVersionId)) : null;
    for (const userId of recipients) {
      await insertNotificationIgnoringDuplicate({
        orgId: input.orgId,
        userId,
        type: input.type,
        title,
        body,
        resourceRef: {
          projectId: input.projectId,
          jobId,
          sourceVersionId,
        },
        readAt: null,
        dedupeKey: `${input.jobId ?? 'none'}:${input.type}`,
        createdBy: null,
        updatedBy: null,
      });
    }
    return recipients.length;
  } catch (err) {
    input.log?.error?.(caughtErrorFields(err), 'notification emit failed; job already terminal');
    return 0;
  }

  /**
   * Builds a user-language body that never includes ids or secrets.
   * @param {string} type Notification type.
   * @param {string | null} projectName Project display name.
   * @returns {string}
   */
  function buildNotificationBody(type, projectName) {
    const base = NOTIFICATION_BODIES[type] ?? NOTIFICATION_BODIES['knowledge.completed'];
    if (typeof projectName === 'string' && projectName.trim()) {
      return `${base.replace('A project', `Project "${projectName.trim()}"`).replace('A repository', `Project "${projectName.trim()}"`)}`.slice(
        0,
        NOTIFICATION_BODY_MAX_CHARS,
      );
    }
    return base;
  }

  /**
   * Inserts one notification row; ignores duplicate-key races.
   * @param {object} doc Notification fields.
   * @returns {Promise<void>}
   */
  async function insertNotificationIgnoringDuplicate(doc) {
    try {
      await Notification.create(doc);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && Number(err.code) === 11000) {
        return;
      }
      throw err;
    }
  }
}

/**
 * Emits inbox rows after a job reaches a terminal status.
 * @param {{
 *   job: object,
 *   result: string,
 *   failureClass?: string | null,
 *   log?: { error?: Function },
 * }} input Terminal job.
 * @returns {Promise<void>}
 */
export async function emitNotificationsForJobTerminal(input) {
  const job = input.job;
  if (!job?.orgId || !job?.projectId) {
    return;
  }
  const jobType = String(job.jobType ?? '');
  const extraUserIds = job.createdBy ? [String(job.createdBy)] : [];
  const base = {
    orgId: String(job.orgId),
    projectId: String(job.projectId),
    jobId: String(job._id ?? job.id),
    sourceVersionId: job.sourceVersionId ? String(job.sourceVersionId) : null,
    extraUserIds,
    log: input.log,
  };

  if (input.failureClass === 'user_action_required') {
    await emitProjectNotification({ ...base, type: 'processing.attention' });
  }

  if (jobType === 'ingest' || jobType === 'reingest') {
    if (input.result === 'completed' || input.result === 'completed_with_warnings') {
      await emitProjectNotification({ ...base, type: 'knowledge.completed' });
      return;
    }
    if (input.result === 'failed') {
      await emitProjectNotification({ ...base, type: 'knowledge.failed' });
    }
    return;
  }

  if (jobType === 'repo_sync') {
    if (input.result === 'completed' || input.result === 'completed_with_warnings') {
      await emitProjectNotification({ ...base, type: 'repo.sync.completed' });
      return;
    }
    if (input.result === 'failed') {
      await emitProjectNotification({ ...base, type: 'repo.sync.failed' });
    }
  }
}

/**
 * Maps a notification document to the list DTO.
 * @param {object} row Notification document.
 * @returns {object}
 */
export function mapNotificationToDto(row) {
  const ref = row.resourceRef ?? {};
  return {
    id: String(row._id ?? row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    resourceRef: {
      projectId: ref.projectId ? String(ref.projectId) : null,
      jobId: ref.jobId ? String(ref.jobId) : null,
      sourceVersionId: ref.sourceVersionId ? String(ref.sourceVersionId) : null,
    },
    readAt: row.readAt instanceof Date ? row.readAt.toISOString() : (row.readAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

/**
 * Lists the caller's notifications.
 * @param {string} orgId Tenant id.
 * @param {string} userId Recipient id.
 * @param {{ unread?: boolean, cursor?: string, limit?: unknown }} [query] List query.
 * @returns {Promise<{ items: object[], nextCursor: string | null, unreadTotal: number }>}
 */
export async function listNotificationsForUser(orgId, userId, query = {}) {
  assertOrgId(orgId);
  const limit =
    typeof query.limit !== 'number' || !Number.isFinite(query.limit) || query.limit < 1
      ? NOTIFICATION_LIST_PAGE_SIZE_DEFAULT
      : Math.min(Math.floor(query.limit), NOTIFICATION_LIST_PAGE_SIZE_MAX);
  /** @type {Record<string, unknown>} */
  const filter = { orgId, userId, status: ROW_STATUS_ACTIVE };
  if (query.unread) {
    filter.readAt = null;
  }
  if (query.cursor) {
    let decoded;
    try {
      decoded = decodeCursor(query.cursor);
    } catch (err) {
      throw apiErrorFromCaught('VALIDATION_ERROR', err, {
        details: [{ path: 'cursor', message: 'cursor is malformed' }],
        logLevel: 'warn',
        logMessage: 'notification list cursor malformed',
      });
    }
    const createdAt = new Date(decoded.t);
    filter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: new mongoose.Types.ObjectId(decoded.i) } }];
  }

  const rows = await Notification.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  /** @type {string | null} */
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }
  const unreadTotal = await Notification.countDocuments({
    orgId,
    userId,
    status: ROW_STATUS_ACTIVE,
    readAt: null,
  }).exec();
  return {
    items: items.map(mapNotificationToDto),
    nextCursor,
    unreadTotal,
  };
}

/**
 * Marks one notification read for the recipient.
 * @param {string} orgId Tenant id.
 * @param {string} userId Recipient id.
 * @param {string} notificationId Notification id.
 * @returns {Promise<{ id: string, readAt: string }>}
 */
export async function markNotificationRead(orgId, userId, notificationId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(notificationId)) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  const now = new Date();
  const updated = await Notification.findOneAndUpdate(
    { _id: notificationId, orgId, userId, status: ROW_STATUS_ACTIVE },
    { $set: { readAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  ).exec();
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  return {
    id: String(updated._id),
    readAt: updated.readAt.toISOString(),
  };
}

/**
 * Marks all unread notifications read for the caller.
 * @param {string} orgId Tenant id.
 * @param {string} userId Recipient id.
 * @returns {Promise<{ updatedCount: number }>}
 */
export async function markAllNotificationsRead(orgId, userId) {
  assertOrgId(orgId);
  const now = new Date();
  const result = await Notification.updateMany(
    { orgId, userId, status: ROW_STATUS_ACTIVE, readAt: null },
    { $set: { readAt: now, updatedAt: now } },
  ).exec();
  return { updatedCount: result.modifiedCount ?? 0 };
}

const listQuerySchema = z.object({
  unread: z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

const idParamsSchema = z.object({
  notificationId: z.string().min(1),
});

/**
 * Registers notification HTTP routes.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function notificationRoutes(app) {
  app.get(
    '/notifications',
    {
      config: { requiredPermissions: ['notifications.view'] },
    },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        });
      }
      const unread = parsed.data.unread === '1' || parsed.data.unread === 'true';
      return listNotificationsForUser(request.principal.orgId, request.principal.userId, {
        unread,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
    },
  );

  app.post(
    '/notifications/:notificationId/read',
    {
      config: { requiredPermissions: ['notifications.view'] },
    },
    async (request) => {
      const params = idParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('NOT_FOUND');
      }
      return markNotificationRead(request.principal.orgId, request.principal.userId, params.data.notificationId);
    },
  );

  app.post(
    '/notifications/read-all',
    {
      config: { requiredPermissions: ['notifications.view'] },
    },
    async (request) => markAllNotificationsRead(request.principal.orgId, request.principal.userId),
  );
}

export const NOTIFICATION_MODELS = Object.freeze([Notification]);
