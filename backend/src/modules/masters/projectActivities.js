/**
 * masters/projectActivities.js — observed ingest/search facts and usage reads.
 *
 * `recordProjectActivity` is best-effort: a write failure must not fail ingest or search.
 * GET /usage/* aggregates `projectActivities` by occurredAt; it never invents question or token numbers.
 */
import mongoose from 'mongoose';
import { z } from 'zod';
import { ProjectActivity, PROJECT_ACTIVITY_KIND_VALUES } from '../../models/projectActivity.model.js';
import { SourceFile } from '../../models/sourceFile.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';

/** Default lookback in days for usage GET. */
export const USAGE_DEFAULT_LOOKBACK_DAYS = 30;

/** Accumulators that turn activity kinds into the GET /usage totals shape. */
const USAGE_SUMMARY_TOTALS = Object.freeze({
  ingestJobsCompleted: {
    $sum: { $cond: [{ $eq: ['$kind', 'ingest.job.completed'] }, '$quantity', 0] },
  },
  sourceBytesAccepted: {
    $sum: { $cond: [{ $eq: ['$kind', 'source.bytes.accepted'] }, '$quantity', 0] },
  },
  searchesExecuted: {
    $sum: { $cond: [{ $eq: ['$kind', 'search.executed'] }, '$quantity', 0] },
  },
});

/**
 * Records one observed project activity. Best-effort: never throws to the caller.
 * @param {{
 *   orgId: string,
 *   projectId?: string | null,
 *   userId?: string | null,
 *   kind: string,
 *   quantity: number,
 *   unit: string,
 *   sourceRef: string,
 *   dedupeKey: string,
 *   occurredAt?: Date,
 *   log?: { error?: Function },
 * }} input Fact.
 * @returns {Promise<boolean>} True when a new row was written.
 */
export async function recordProjectActivity(input) {
  try {
    assertOrgId(input.orgId);
    if (!input.projectId) {
      return false;
    }
    if (!PROJECT_ACTIVITY_KIND_VALUES.includes(input.kind)) {
      return false;
    }
    const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date();
    try {
      await ProjectActivity.create({
        orgId: input.orgId,
        projectId: input.projectId,
        userId: input.userId ?? null,
        kind: input.kind,
        quantity: input.quantity,
        unit: input.unit,
        sourceRef: input.sourceRef,
        dedupeKey: input.dedupeKey,
        occurredAt,
        createdBy: null,
        updatedBy: null,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && Number(err.code) === 11000) {
        return false;
      }
      throw err;
    }
    return true;
  } catch (err) {
    input.log?.error?.({ errName: err instanceof Error ? err.name : 'Error' }, 'project activity record failed');
    return false;
  }
}

/**
 * Sums stored byte lengths for accepted files of a source version.
 * @param {string} orgId Tenant id.
 * @param {string} sourceVersionId Source version id.
 * @returns {Promise<number>}
 */
export async function sumAcceptedSourceBytes(orgId, sourceVersionId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(sourceVersionId)) {
    return 0;
  }
  const rows = await SourceFile.aggregate([
    {
      $match: {
        orgId: new mongoose.Types.ObjectId(String(orgId)),
        sourceVersionId: new mongoose.Types.ObjectId(String(sourceVersionId)),
        status: ROW_STATUS_ACTIVE,
      },
    },
    { $group: { _id: null, total: { $sum: '$byteLength' } } },
  ]).exec();
  return Number(rows[0]?.total ?? 0);
}

/**
 * Records ingest/sync activity after a successful job.
 * @param {{ job: object, log?: { error?: Function } }} input Terminal job.
 * @returns {Promise<void>}
 */
export async function recordProjectActivitiesForJobTerminal(input) {
  const job = input.job;
  if (!job?.orgId || !job.projectId) {
    return;
  }
  const jobType = String(job.jobType ?? '');
  if (jobType !== 'ingest' && jobType !== 'reingest' && jobType !== 'repo_sync') {
    return;
  }
  const jobId = String(job._id ?? job.id);
  await recordProjectActivity({
    orgId: String(job.orgId),
    projectId: String(job.projectId),
    userId: job.createdBy ? String(job.createdBy) : null,
    kind: 'ingest.job.completed',
    quantity: 1,
    unit: 'jobs',
    sourceRef: jobId,
    dedupeKey: `ingest.job.completed:${jobId}`,
    log: input.log,
  });
  if (!job.sourceVersionId) {
    return;
  }
  const bytes = await sumAcceptedSourceBytes(String(job.orgId), String(job.sourceVersionId));
  if (bytes <= 0) {
    return;
  }
  await recordProjectActivity({
    orgId: String(job.orgId),
    projectId: String(job.projectId),
    userId: job.createdBy ? String(job.createdBy) : null,
    kind: 'source.bytes.accepted',
    quantity: bytes,
    unit: 'bytes',
    sourceRef: String(job.sourceVersionId),
    dedupeKey: `source.bytes.accepted:${job.sourceVersionId}`,
    log: input.log,
  });
}

/**
 * Aggregates project activities for a date range.
 * @param {{
 *   orgId: string,
 *   projectId?: string | null,
 *   userId?: string | null,
 *   from: Date,
 *   to: Date,
 * }} input Scope.
 * @returns {Promise<object>}
 */
export async function loadUsageSummary(input) {
  assertOrgId(input.orgId);
  /** @type {Record<string, unknown>} */
  const match = {
    orgId: new mongoose.Types.ObjectId(String(input.orgId)),
    status: ROW_STATUS_ACTIVE,
    occurredAt: {
      $gte: input.from,
      $lte: input.to,
    },
  };
  if (input.projectId) {
    match.projectId = new mongoose.Types.ObjectId(String(input.projectId));
  }
  if (input.userId) {
    match.userId = new mongoose.Types.ObjectId(String(input.userId));
  }
  const grouped = await ProjectActivity.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        ...USAGE_SUMMARY_TOTALS,
      },
    },
  ]).exec();
  const totals = grouped[0] ?? {
    ingestJobsCompleted: 0,
    sourceBytesAccepted: 0,
    searchesExecuted: 0,
  };
  const byProject = await ProjectActivity.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$projectId',
        ...USAGE_SUMMARY_TOTALS,
      },
    },
  ]).exec();
  const byUserMatch = input.userId ? match : { ...match, userId: { $ne: null } };
  const byUser = await ProjectActivity.aggregate([
    { $match: byUserMatch },
    {
      $group: {
        _id: '$userId',
        ...USAGE_SUMMARY_TOTALS,
      },
    },
  ]).exec();
  return {
    period: {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    },
    totals: {
      ingestJobsCompleted: totals.ingestJobsCompleted,
      sourceBytesAccepted: totals.sourceBytesAccepted,
      searchesExecuted: totals.searchesExecuted,
    },
    byProject: byProject
      .filter((row) => row._id)
      .map((row) => ({
        projectId: String(row._id),
        ingestJobsCompleted: row.ingestJobsCompleted,
        sourceBytesAccepted: row.sourceBytesAccepted,
        searchesExecuted: row.searchesExecuted,
      })),
    byUser: byUser.map((row) => ({
      userId: String(row._id),
      ingestJobsCompleted: row.ingestJobsCompleted,
      sourceBytesAccepted: row.sourceBytesAccepted,
      searchesExecuted: row.searchesExecuted,
    })),
  };
}

/**
 * Resolves the default lookback window.
 * @returns {{ from: Date, to: Date }}
 */
function defaultUsageWindow() {
  const to = new Date();
  const from = new Date(to.getTime() - USAGE_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

const orgQuerySchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
});

const projectParamsSchema = z.object({
  projectId: z.string().min(1),
});

/**
 * Parses optional ISO instants.
 * @param {string | undefined} value Raw.
 * @param {string} path Field name.
 * @returns {Date | undefined}
 */
function parseOptionalInstant(value, path) {
  if (value == null) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path, message: `${path} must be a valid ISO-8601 instant` }],
    });
  }
  return date;
}

/**
 * Registers usage HTTP routes.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function usageRoutes(app) {
  app.get(
    '/usage/organization',
    {
      config: { requiredPermissions: ['usage.view'] },
    },
    async (request) => {
      const parsed = orgQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        });
      }
      const window = defaultUsageWindow();
      const from = parseOptionalInstant(parsed.data.from, 'from') ?? window.from;
      const to = parseOptionalInstant(parsed.data.to, 'to') ?? window.to;
      return loadUsageSummary({ orgId: request.principal.orgId, from, to });
    },
  );

  app.get(
    '/usage/projects/:projectId',
    {
      config: { requiredPermissions: ['usage.view'] },
    },
    async (request) => {
      const params = projectParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'projectId', message: 'projectId is required' }],
        });
      }
      const window = defaultUsageWindow();
      return loadUsageSummary({
        orgId: request.principal.orgId,
        projectId: params.data.projectId,
        from: window.from,
        to: window.to,
      });
    },
  );

  app.get(
    '/usage/me',
    {
      config: { routeAccess: 'authenticated' },
    },
    async (request) => {
      const window = defaultUsageWindow();
      return loadUsageSummary({
        orgId: request.principal.orgId,
        userId: request.principal.userId,
        from: window.from,
        to: window.to,
      });
    },
  );
}

export const PROJECT_ACTIVITY_MODELS = Object.freeze([ProjectActivity]);
