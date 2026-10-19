/**
 * masters/projects.js — merged resource file.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { Project } from '../../models/projects.model.js';
import { ensureAgedOrgDataCleanupJobSoon } from './jobs.helper.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../access/index.js';
import { buildProjectMemberSubdoc, resolveAccessibleProjectFilter } from './projectMembers.js';
import {
  findProjectById,
  softDeleteProject,
  updateProjectMetadata,
  updateProjectSettings,
  conditionalLifecycleUpdate,
  touchProjectLastAccessedAt,
  initialLifecycleAfterCreate,
  assertKnowledgeHealthAllowed,
  assertLifecycleTransitionAllowed,
  listProjects as listProjectsInRepo,
  createProject as createProjectInRepo,
} from './projects.helper.js';

// --- from projects/projects.routes.js ---
/**
 * Project HTTP routes under `/api/v1`.
 */
const createBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  sourceType: z.enum(['upload', 'repository']),
});
// Unknown keys (e.g. forged orgId) are stripped — never trusted from the client.

const patchBodySchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'At least one of name or description is required',
  });

const settingsBodySchema = z
  .object({
    projectId: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
  })
  .strict();

const listQuerySchema = z.object({
  q: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  sort: z.enum(['updatedAt', 'lastAccessedAt']).optional(),
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});
// Unknown query keys (e.g. forged orgId) are stripped.

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

// Body for mutating project actions that only need the target project (recordAccess, archive, restore, delete, ...).
const projectIdBodySchema = z.object({ projectId: z.string().min(1) }).strict();

/**
 * POST /masters/projects/create — create a project for the org.
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {import('fastify').FastifyReply} reply Reply.
 */
export async function createProjectHttp(request, reply) {
  const parsed = createBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  const project = await createProject({
    ...ctx,
    name: parsed.data.name,
    description: parsed.data.description,
    sourceType: parsed.data.sourceType,
  });
  return reply.code(201).send(project);
}

/**
 * GET /masters/projects/list — list projects visible to the caller.
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function listProjectsHttp(request) {
  const parsed = listQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  if (parsed.data.limit === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'limit', message: 'limit must be a positive integer' }],
    });
  }
  return listProjects(request.principal.orgId, request.principal.userId, parsed.data);
}

/**
 * GET /masters/projects/get/:projectId — project detail (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function getProjectHttp(request) {
  const params = projectIdParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  return getProject(request.projectScope.orgId, request.projectScope.projectId);
}

/**
 * POST /masters/projects/recordAccess — record last-accessed for the caller.
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function recordProjectAccessHttp(request) {
  const parsed = projectIdBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return recordProjectAccess(request.projectScope.orgId, request.projectScope.projectId);
}

/**
 * PATCH /masters/projects/update — update project metadata (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function updateProjectHttp(request) {
  const parsed = patchBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  return updateProject({
    ...ctx,
    projectId: request.projectScope.projectId,
    name: parsed.data.name,
    description: parsed.data.description,
  });
}

/**
 * POST /masters/projects/fillDescriptionFromReadme — LLM description from root README.
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function fillProjectDescriptionFromReadmeHttp(request) {
  const parsed = projectIdBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  return fillProjectDescriptionFromReadme({
    ...ctx,
    projectId: request.projectScope.projectId,
  });
}

/**
 * GET /masters/projects/getSettings/:projectId — read project settings (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function getProjectSettingsHttp(request) {
  const params = projectIdParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  return getProjectSettings(request.projectScope.orgId, request.projectScope.projectId);
}

/**
 * PATCH /masters/projects/updateSettings — merge project settings (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function updateProjectSettingsHttp(request) {
  const parsed = settingsBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  return patchProjectSettings({
    ...ctx,
    projectId: request.projectScope.projectId,
    settings: parsed.data.settings,
  });
}

/**
 * POST /masters/projects/archive — archive project lifecycle (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function archiveProjectHttp(request) {
  const parsed = projectIdBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  return archiveProject({ ...ctx, projectId: request.projectScope.projectId });
}

/**
 * POST /masters/projects/restore — restore archived project (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function restoreProjectHttp(request) {
  const parsed = projectIdBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  return restoreProject({ ...ctx, projectId: request.projectScope.projectId });
}

/**
 * GET /masters/projects/getDeletionPreview/:projectId — counts before delete (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function getProjectDeletionPreviewHttp(request) {
  const params = projectIdParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  return getDeletionPreview(request.projectScope.orgId, request.projectScope.projectId);
}

/**
 * DELETE /masters/projects/delete — soft-delete project (project ACL).
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {import('fastify').FastifyReply} reply Reply.
 */
export async function deleteProjectHttp(request, reply) {
  const parsed = projectIdBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  await deleteProject({ ...ctx, projectId: request.projectScope.projectId });
  return reply.code(204).send();
}

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        details.push({ path: String(key), message: 'Unrecognized key' });
      }
      continue;
    }
    details.push({
      path: issue.path.join('.') || 'body',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Shared request context for project services.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {{
 *   orgId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log: import('fastify').FastifyBaseLogger,
 * }}
 */
function serviceContext(request) {
  const audit = buildAuditContextFromRequest(request);
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    actorUserId: /** @type {string} */ (request.principal.userId),
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  };
}

// --- from projects/projects.service.js ---
/**
 * Project use cases — CRUD, lifecycle transitions, audit, deletion preview.
 */
/** Known setting keys accepted by PATCH /masters/projects/updateSettings/:projectId (empty in Phase 17). */
export const PROJECT_SETTING_KEYS = Object.freeze([]);

const PROJECT_SETTING_KEY_SET = new Set(PROJECT_SETTING_KEYS);

/**
 * Returns whether `key` is a registered project setting.
 * @param {string} key Candidate setting key.
 * @returns {boolean}
 */
export function isKnownProjectSettingKey(key) {
  return typeof key === 'string' && PROJECT_SETTING_KEY_SET.has(key);
}

/**
 * Validates a settings object against the registry.
 * @param {Record<string, unknown>} settings Candidate settings patch.
 * @returns {{ ok: true } | { ok: false, unknownKeys: string[] }}
 */
export function validateProjectSettingsKeys(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, unknownKeys: ['settings'] };
  }
  const unknownKeys = Object.keys(settings).filter((key) => !isKnownProjectSettingKey(key));
  if (unknownKeys.length > 0) {
    return { ok: false, unknownKeys };
  }
  return { ok: true };
}

/**
 * Maps a project document to the API DTO.
 * @param {object} project Project document or lean object.
 * @param {{ detail?: boolean }} [options] When detail, include archivedAt and version id.
 * @returns {object}
 */
export function mapProjectToDto(project, options = {}) {
  const detail = options.detail === true;
  const counts = project.counts ?? {};
  const sourceConfig = project.sourceConfig ?? {};
  /** @type {Record<string, unknown>} */
  const source = { sourceType: sourceConfig.sourceType };
  if (sourceConfig.repositoryConnectionId) {
    source.repositoryConnectionId = String(sourceConfig.repositoryConnectionId);
  }
  if (sourceConfig.currentSourceVersionId) {
    source.currentSourceVersionId = String(sourceConfig.currentSourceVersionId);
  }

  /** @type {Record<string, unknown>} */
  const dto = {
    id: String(project._id ?? project.id),
    name: project.name,
    description: project.description ?? '',
    lifecycleStatus: project.lifecycleStatus,
    knowledgeHealth: project.knowledgeHealth,
    sourceConfig: source,
    counts: {
      sourceVersions: counts.sourceVersions ?? 0,
      files: counts.files ?? 0,
      excludedFiles: counts.excludedFiles ?? 0,
      conversations: counts.conversations ?? 0,
    },
    lastAccessedAt: toIsoOrNull(project.lastAccessedAt),
    createdBy: project.createdBy ? String(project.createdBy) : null,
    createdAt: toIsoOrEmpty(project.createdAt),
    updatedAt: toIsoOrEmpty(project.updatedAt),
  };

  if (detail) {
    dto.archivedAt = toIsoOrNull(project.archivedAt);
    dto.currentKnowledgeVersionId = project.currentKnowledgeVersionId ? String(project.currentKnowledgeVersionId) : null;
    dto.settings = project.settings && typeof project.settings === 'object' ? { ...project.settings } : {};
    dto.lifecycleStatusReasonCode = project.lifecycleStatusReasonCode ?? null;
    dto.lifecycleStatusChangedAt = toIsoOrNull(project.lifecycleStatusChangedAt);
  }

  return dto;
}

/** Deletion preview: children cascade via aged_org_data_cleanup; audit kept until auditDays. */
export const DELETION_PREVIEW_CONSEQUENCES = Object.freeze([
  Object.freeze({ resource: 'source', effect: 'soft_deleted', retentionDays: null }),
  Object.freeze({ resource: 'knowledge', effect: 'soft_deleted', retentionDays: null }),
  Object.freeze({
    resource: 'conversations',
    effect: 'soft_deleted',
    retentionDays: 365,
  }),
  Object.freeze({
    resource: 'processing_history',
    effect: 'soft_deleted',
    retentionDays: 180,
  }),
  Object.freeze({ resource: 'audit_events', effect: 'retained', retentionDays: 730 }),
]);

/**
 * Applies a validated lifecycle transition with one race retry.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   from: string,
 *   to: string,
 *   source: 'api' | 'worker',
 *   reasonCode?: string | null,
 *   actorUserId?: string | null,
 *   knowledgeVersionId?: string | null,
 *   sourceVersionId?: string | null,
 *   knowledgeHealth?: string | null,
 *   session?: import('mongoose').ClientSession,
 *   preArchiveLifecycleStatus?: string | null,
 *   clearPreArchive?: boolean,
 *   archivedAt?: Date | null,
 * }} input Transition inputs.
 * @returns {Promise<import('mongoose').Document>}
 * @throws {ApiError} INVALID_STATE_TRANSITION | NOT_FOUND
 */
export async function transitionLifecycle(input) {
  assertLifecycleTransitionAllowed({
    from: input.from,
    to: input.to,
    source: input.source,
    knowledgeVersionId: input.knowledgeVersionId,
  });

  if (input.knowledgeHealth !== undefined && input.knowledgeHealth !== null) {
    assertKnowledgeHealthAllowed({
      lifecycleStatus: input.to,
      knowledgeHealth: input.knowledgeHealth,
    });
  }

  const sessionOpts = input.session ? { session: input.session } : {};
  const updated = await conditionalLifecycleUpdate(
    input.orgId,
    input.projectId,
    {
      from: input.from,
      to: input.to,
      reasonCode: input.reasonCode ?? null,
      updatedBy: input.actorUserId ?? null,
      preArchiveLifecycleStatus: input.preArchiveLifecycleStatus,
      clearPreArchive: input.clearPreArchive,
      archivedAt: input.archivedAt,
      currentKnowledgeVersionId: input.knowledgeVersionId,
      currentSourceVersionId: input.sourceVersionId,
      knowledgeHealth: input.knowledgeHealth,
    },
    sessionOpts,
  );

  if (updated) {
    return updated;
  }

  const current = await findProjectById(input.orgId, input.projectId, sessionOpts);
  if (!current) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  assertLifecycleTransitionAllowed({
    from: current.lifecycleStatus,
    to: input.to,
    source: input.source,
    knowledgeVersionId: input.knowledgeVersionId,
  });

  if (input.knowledgeHealth !== undefined && input.knowledgeHealth !== null) {
    assertKnowledgeHealthAllowed({
      lifecycleStatus: input.to,
      knowledgeHealth: input.knowledgeHealth,
    });
  }

  const retried = await conditionalLifecycleUpdate(
    input.orgId,
    input.projectId,
    {
      from: current.lifecycleStatus,
      to: input.to,
      reasonCode: input.reasonCode ?? null,
      updatedBy: input.actorUserId ?? null,
      preArchiveLifecycleStatus: input.preArchiveLifecycleStatus,
      clearPreArchive: input.clearPreArchive,
      archivedAt: input.archivedAt,
      currentKnowledgeVersionId: input.knowledgeVersionId,
      currentSourceVersionId: input.sourceVersionId,
      knowledgeHealth: input.knowledgeHealth,
    },
    sessionOpts,
  );

  if (!retried) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: current.lifecycleStatus, to: input.to },
    });
  }
  return retried;
}

/**
 * Creates a project and transitions out of `creating`.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   name: string,
 *   description?: string,
 *   sourceType: 'upload' | 'repository',
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Create inputs.
 * @returns {Promise<object>} Project DTO.
 */
export async function createProject(input) {
  const created = await createProjectInRepo(input.orgId, {
    name: input.name,
    description: input.description,
    sourceType: input.sourceType,
    createdBy: input.actorUserId,
    members: [
      buildProjectMemberSubdoc({
        userId: input.actorUserId,
        roleId: null,
        permissions: [],
        addedByUserId: input.actorUserId,
        createdBy: input.actorUserId,
      }),
    ],
  });

  const nextStatus = initialLifecycleAfterCreate(input.sourceType);
  const transitioned = await transitionLifecycle({
    orgId: input.orgId,
    projectId: String(created._id),
    from: 'creating',
    to: nextStatus,
    source: 'api',
    reasonCode: 'project_created',
    actorUserId: input.actorUserId,
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.create',
      resourceType: 'project',
      resourceId: String(transitioned._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        name: transitioned.name,
        sourceType: input.sourceType,
        lifecycleStatus: transitioned.lifecycleStatus,
      },
    },
    { log: input.log },
  );

  return mapProjectToDto(transitioned, { detail: true });
}

/**
 * Lists projects visible to the caller under project ACL.
 * @param {string} orgId Tenant id.
 * @param {string} userId Caller user id.
 * @param {{
 *   q?: string,
 *   includeArchived?: boolean,
 *   cursor?: string,
 *   limit?: number,
 *   sort?: 'updatedAt' | 'lastAccessedAt',
 * }} [filters] List filters.
 * @returns {Promise<{ items: object[], pageInfo: object }>}
 */
export async function listProjects(orgId, userId, filters = {}) {
  const access = await resolveAccessibleProjectFilter(orgId, userId);
  /** @type {Parameters<typeof listProjectsInRepo>[1]} */
  const repoFilters = { ...filters };
  if (access.mode === 'none') {
    repoFilters.emptyResult = true;
  } else if (access.mode === 'selected') {
    repoFilters.projectIds = access.projectIds;
  }
  const page = await listProjectsInRepo(orgId, repoFilters);
  return {
    items: page.items.map((project) => mapProjectToDto(project)),
    pageInfo: page.pageInfo,
  };
}

/**
 * Returns one project DTO or throws NOT_FOUND.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<object>}
 */
export async function getProject(orgId, projectId) {
  const project = await findProjectById(orgId, projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  return mapProjectToDto(project, { detail: true });
}

/**
 * Records that a project was opened (org-scoped lastAccessedAt bump).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<object>} Updated project detail DTO.
 */
export async function recordProjectAccess(orgId, projectId) {
  const updated = await touchProjectLastAccessedAt(orgId, projectId);
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  return mapProjectToDto(updated, { detail: true });
}

/** Max UTF-8 bytes of root README sent to the LLM for a project description. */
export const PROJECT_DESCRIPTION_README_MAX_BYTES = 65_536;

/** Target max characters for the LLM-written project description. */
export const PROJECT_DESCRIPTION_TARGET_MAX_CHARS = 400;

/** Hard clamp matching `projects.description` maxlength. */
export const PROJECT_DESCRIPTION_HARD_MAX_CHARS = 2000;

/**
 * Loads the root README, asks the LLM for a short blurb, and overwrites project.description.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Fill inputs.
 * @returns {Promise<object>} Updated project detail DTO.
 */
export async function fillProjectDescriptionFromReadme(input) {
  const existing = await findProjectById(input.orgId, input.projectId);
  if (!existing) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  const sourceVersionId = existing.sourceConfig?.currentSourceVersionId ? String(existing.sourceConfig.currentSourceVersionId) : null;
  if (!sourceVersionId) {
    throw ApiError.fromCode('SOURCE_VERSION_NOT_FOUND', {
      message: 'No current source version is available for this project.',
    });
  }

  const { listSourceFilesOrdered, findSourceFileByPath, readSourceGridFsBytes } = await import('../knowledge/index.js');
  const files = await listSourceFilesOrdered({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId,
  });
  const readmePath = resolveRootReadmePath(files);
  if (!readmePath) {
    throw ApiError.fromCode('SOURCE_NOT_FOUND', {
      message: 'No root README.md was found in the current source version.',
    });
  }

  const file = await findSourceFileByPath({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId,
    path: readmePath,
  });
  if (!file?.gridFsId) {
    throw ApiError.fromCode('SOURCE_NOT_FOUND', {
      message: 'No root README.md was found in the current source version.',
    });
  }

  const bytes = await readSourceGridFsBytes(file.gridFsId);
  const readmeText = bytes.toString('utf8').slice(0, PROJECT_DESCRIPTION_README_MAX_BYTES).trim();
  if (!readmeText) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'readme', message: 'README.md is empty' }],
    });
  }

  const { generateTextWithoutBudget } = await import('../conversation/index.js');
  const result = await generateTextWithoutBudget({
    purpose: 'project_description',
    enableThinking: false,
    instructions:
      'Write a short project description from the README. Reply with 1–2 plain sentences, ' +
      `at most ${PROJECT_DESCRIPTION_TARGET_MAX_CHARS} characters. No markdown, headings, or quotes.`,
    messages: [{ role: 'user', content: readmeText }],
  });

  const blurb = String(result?.text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, PROJECT_DESCRIPTION_HARD_MAX_CHARS);
  if (!blurb) {
    throw ApiError.fromCode('LLM_PROVIDER_ERROR', {
      message: 'The language model returned an empty project description.',
    });
  }

  const updated = await updateProjectMetadata(input.orgId, input.projectId, {
    description: blurb,
    updatedBy: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.description_filled_from_readme',
      resourceType: 'project',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        readmePath,
        descriptionLength: blurb.length,
      },
    },
    { log: input.log },
  );

  return mapProjectToDto(updated, { detail: true });

  /**
   * Picks a root-level README.md path (case-insensitive); prefers exact `README.md`.
   * @param {Array<{ path?: string }>} sourceFiles Source file rows.
   * @returns {string | null}
   */
  function resolveRootReadmePath(sourceFiles) {
    if (!Array.isArray(sourceFiles)) {
      return null;
    }
    /** @type {string[]} */
    const roots = [];
    for (const sourceFile of sourceFiles) {
      const pathValue = typeof sourceFile?.path === 'string' ? sourceFile.path : '';
      if (!pathValue || pathValue.includes('/')) {
        continue;
      }
      if (pathValue.toLowerCase() === 'readme.md') {
        roots.push(pathValue);
      }
    }
    if (roots.length === 0) {
      return null;
    }
    return roots.find((pathValue) => pathValue === 'README.md') ?? roots[0];
  }
}

/**
 * Patches name and/or description.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   name?: string,
 *   description?: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Patch inputs.
 * @returns {Promise<object>}
 */
export async function updateProject(input) {
  const existing = await findProjectById(input.orgId, input.projectId);
  if (!existing) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  const updated = await updateProjectMetadata(input.orgId, input.projectId, {
    name: input.name,
    description: input.description,
    updatedBy: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.update',
      resourceType: 'project',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        name: updated.name,
        description: updated.description,
      },
    },
    { log: input.log },
  );

  return mapProjectToDto(updated, { detail: true });
}

/**
 * Returns project settings.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<{ settings: Record<string, unknown> }>}
 */
export async function getProjectSettings(orgId, projectId) {
  const project = await findProjectById(orgId, projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  const settings = project.settings && typeof project.settings === 'object' ? { ...project.settings } : {};
  return { settings };
}

/**
 * Patches project settings against the empty Phase 17 registry.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   settings: Record<string, unknown>,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Settings inputs.
 * @returns {Promise<{ settings: Record<string, unknown> }>}
 */
export async function patchProjectSettings(input) {
  const validation = validateProjectSettingsKeys(input.settings);
  if (!validation.ok) {
    throw ApiError.fromCode('UNKNOWN_SETTING', {
      details: { unknownKeys: validation.unknownKeys },
    });
  }

  const existing = await findProjectById(input.orgId, input.projectId);
  if (!existing) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  const nextSettings = { ...(existing.settings ?? {}), ...input.settings };
  const updated = await updateProjectSettings(input.orgId, input.projectId, {
    settings: nextSettings,
    updatedBy: input.actorUserId,
  });
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.settings_changed',
      resourceType: 'project',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { keys: Object.keys(input.settings) },
    },
    { log: input.log },
  );

  const settings = updated.settings && typeof updated.settings === 'object' ? { ...updated.settings } : {};
  return { settings };
}

/**
 * Archives an active non-archived project.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Archive inputs.
 * @returns {Promise<object>}
 */
export async function archiveProject(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  if (project.lifecycleStatus === 'archived') {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: 'archived', to: 'archived' },
    });
  }

  const updated = await transitionLifecycle({
    orgId: input.orgId,
    projectId: input.projectId,
    from: project.lifecycleStatus,
    to: 'archived',
    source: 'api',
    reasonCode: 'project_archived',
    actorUserId: input.actorUserId,
    preArchiveLifecycleStatus: project.lifecycleStatus,
    archivedAt: new Date(),
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.archive',
      resourceType: 'project',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        previousLifecycleStatus: project.lifecycleStatus,
      },
    },
    { log: input.log },
  );

  return mapProjectToDto(updated, { detail: true });
}

/**
 * Restores an archived project to preArchiveLifecycleStatus.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Restore inputs.
 * @returns {Promise<object>}
 */
export async function restoreProject(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  if (project.lifecycleStatus !== 'archived' || !project.preArchiveLifecycleStatus) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: {
        from: project.lifecycleStatus,
        to: project.preArchiveLifecycleStatus ?? null,
        reason: 'not_archived',
      },
    });
  }

  const restoreTo = project.preArchiveLifecycleStatus;
  // Restore is the only path out of archived; bypass table for archived→previous.
  const updated = await conditionalLifecycleUpdate(input.orgId, input.projectId, {
    from: 'archived',
    to: restoreTo,
    reasonCode: 'project_restored',
    updatedBy: input.actorUserId,
    clearPreArchive: true,
    archivedAt: null,
  });
  if (!updated) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from: 'archived', to: restoreTo },
    });
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.restore',
      resourceType: 'project',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { restoredLifecycleStatus: restoreTo },
    },
    { log: input.log },
  );

  return mapProjectToDto(updated, { detail: true });
}

/**
 * Builds deletion consequences from stored counts (jobs default 0 until Phase 20).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<object>}
 */
export async function getDeletionPreview(orgId, projectId) {
  const project = await findProjectById(orgId, projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }
  const counts = project.counts ?? {};
  return {
    counts: {
      sourceVersions: counts.sourceVersions ?? 0,
      files: counts.files ?? 0,
      conversations: counts.conversations ?? 0,
      jobs: 0,
    },
    consequences: [...DELETION_PREVIEW_CONSEQUENCES],
  };
}

/**
 * Soft-deletes a project.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Delete inputs.
 * @returns {Promise<void>}
 */
export async function deleteProject(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  const result = await softDeleteProject(input.orgId, input.projectId, {
    updatedBy: input.actorUserId,
  });
  if (!result.matchedCount) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.delete',
      resourceType: 'project',
      resourceId: String(input.projectId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        name: project.name,
        lifecycleStatus: project.lifecycleStatus,
      },
    },
    { log: input.log },
  );

  try {
    await ensureAgedOrgDataCleanupJobSoon(input.orgId);
  } catch (error) {
    input.log?.error?.(
      {
        errName: error instanceof Error ? error.name : 'Error',
        errMessage: error instanceof Error ? error.message : String(error),
        errStack: error instanceof Error ? error.stack : undefined,
        orgId: input.orgId,
        projectId: String(input.projectId),
      },
      'failed to enqueue aged_org_data_cleanup after project delete',
    );
  }
}

export {
  findProjectById,
  createProject as createProjectInRepo,
  listProjects as listProjectsInRepo,
  adjustProjectConversationCount,
  setProjectSourceSnapshotCounts,
  touchProjectLastAccessedAt,
  updateProjectMetadata,
  updateProjectSettings,
  updateProjectSourceConfig,
  conditionalLifecycleUpdate,
  softDeleteProject,
  LIFECYCLE_TRANSITIONS,
  WORKER_ONLY_LIFECYCLE_STATUSES,
  PRE_KNOWLEDGE_LIFECYCLE_STATUSES,
  isKnownLifecycleStatus,
  isKnownKnowledgeHealth,
  initialLifecycleAfterCreate,
  assertLifecycleTransitionAllowed,
  assertKnowledgeHealthAllowed,
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_LIMIT,
  clampProjectsListLimit,
  resolveProjectsListSort,
} from './projects.helper.js';

/**
 * Formats a date field as ISO-8601, or empty string when missing.
 * @param {unknown} value Date or string.
 * @returns {string}
 */
function toIsoOrEmpty(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
}

/**
 * Formats a date field as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

export { Project };
export const PROJECT_MODELS = Object.freeze([Project]);
