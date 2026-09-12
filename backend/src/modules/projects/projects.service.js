/**
 * Project use cases — CRUD, lifecycle transitions, audit, deletion preview.
 */
import { ApiError } from '../../platform/errors.js';
import { recordAuditEvent } from '../audit/index.js';
import {
  ensureCreatorProjectMember,
  resolveAccessibleProjectFilter,
} from '../projectMembers/index.js';
import {
  assertLifecycleTransitionAllowed,
  assertKnowledgeHealthAllowed,
  initialLifecycleAfterCreate,
} from './projects.lifecycle.js';
import {
  conditionalLifecycleUpdate,
  createProject as createProjectInRepo,
  findProjectById,
  listProjects as listProjectsInRepo,
  softDeleteProject,
  updateProjectMetadata,
  updateProjectSettings,
} from './projects.repository.js';
import { validateProjectSettingsKeys } from './projects.settingsRegistry.js';
import { mapProjectToDto } from './projects.types.js';

/** Retention defaults mirrored from solution §12.3 for deletion-preview. */
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

  const updated = await conditionalLifecycleUpdate(input.orgId, input.projectId, {
    from: input.from,
    to: input.to,
    reasonCode: input.reasonCode ?? null,
    updatedBy: input.actorUserId ?? null,
    preArchiveLifecycleStatus: input.preArchiveLifecycleStatus,
    clearPreArchive: input.clearPreArchive,
    archivedAt: input.archivedAt,
    currentKnowledgeVersionId: input.knowledgeVersionId,
  });

  if (updated) {
    return updated;
  }

  const current = await findProjectById(input.orgId, input.projectId);
  if (!current) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Project not found.' });
  }

  assertLifecycleTransitionAllowed({
    from: current.lifecycleStatus,
    to: input.to,
    source: input.source,
    knowledgeVersionId: input.knowledgeVersionId,
  });

  const retried = await conditionalLifecycleUpdate(input.orgId, input.projectId, {
    from: current.lifecycleStatus,
    to: input.to,
    reasonCode: input.reasonCode ?? null,
    updatedBy: input.actorUserId ?? null,
    preArchiveLifecycleStatus: input.preArchiveLifecycleStatus,
    clearPreArchive: input.clearPreArchive,
    archivedAt: input.archivedAt,
    currentKnowledgeVersionId: input.knowledgeVersionId,
  });

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

  await ensureCreatorProjectMember({
    orgId: input.orgId,
    projectId: String(transitioned._id),
    userId: input.actorUserId,
  });

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
  const settings =
    project.settings && typeof project.settings === 'object' ? { ...project.settings } : {};
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

  const settings =
    updated.settings && typeof updated.settings === 'object' ? { ...updated.settings } : {};
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
}

export { assertKnowledgeHealthAllowed };
