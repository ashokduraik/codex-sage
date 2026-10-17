/**
 * HTTP route catalog — every `/api/v1` URL, its permission config, and the named
 * `*Http` handler (implementation lives in the owning module file).
 * Product paths are `/{module}/{file}/{action}/:ids…`; health stays flat.
 * Mounted under `API_BASE_PATH` from `http/app.js`. Root `/health` and `/readiness`
 * reuse the same health handlers outside this plugin.
 */
import { getHealthHttp, getReadinessHttp } from './health.routes.js';
import { requireProjectPermission } from './preHandlers/requireProjectPermission.js';
import {
  loginHttp,
  logoutHttp,
  getAuditEventHttp,
  getCurrentUserHttp,
  refreshSessionHttp,
  listAuditEventsHttp,
  listPermissionsHttp,
  changeOwnPasswordHttp,
} from '../modules/access/index.js';
import {
  getConversationHttp,
  listConversationsHttp,
  createConversationHttp,
  deleteConversationHttp,
  renameConversationHttp,
  archiveConversationHttp,
  restoreConversationHttp,
  searchConversationsHttp,
  getConversationContextHttp,
  listConversationMessagesHttp,
  streamConversationMessageHttp,
} from '../modules/conversation/index.js';
import {
  searchProjectHttp,
  reingestSourceHttp,
  syncRepositoryHttp,
  probeRepositoryHttp,
  attachRepositoryHttp,
  getKnowledgeIndexHttp,
  listKnowledgeApisHttp,
  getKnowledgeHealthHttp,
  getKnowledgeSummaryHttp,
  readSourceFileSliceHttp,
  uploadProjectSourceHttp,
  listKnowledgeSymbolsHttp,
  getSourceFileMetadataHttp,
  listKnowledgeWorkflowsHttp,
  updateRepositoryBranchHttp,
  getRepositoryConnectionHttp,
  getLatestKnowledgeUpdateHttp,
  listProjectSourceVersionsHttp,
  retestRepositoryConnectionHttp,
  revokeRepositoryCredentialHttp,
  replaceRepositoryCredentialHttp,
} from '../modules/knowledge/index.js';
import {
  getJobHttp,
  getUserHttp,
  retryJobHttp,
  cancelJobHttp,
  listRolesHttp,
  listUsersHttp,
  createRoleHttp,
  createUserHttp,
  deleteRoleHttp,
  deleteUserHttp,
  getMyUsageHttp,
  getProjectHttp,
  updateRoleHttp,
  updateUserHttp,
  activateUserHttp,
  listProjectsHttp,
  createProjectHttp,
  deleteProjectHttp,
  updateProjectHttp,
  archiveProjectHttp,
  deactivateUserHttp,
  restoreProjectHttp,
  getProjectUsageHttp,
  listProjectJobsHttp,
  addProjectMemberHttp,
  replaceUserRolesHttp,
  listNotificationsHttp,
  resetUserPasswordHttp,
  getProjectSettingsHttp,
  listProjectMembersHttp,
  recordProjectAccessHttp,
  removeProjectMemberHttp,
  getOrganizationUsageHttp,
  markNotificationReadHttp,
  updateProjectSettingsHttp,
  markAllNotificationsReadHttp,
  getProjectDeletionPreviewHttp,
} from '../modules/masters/index.js';

/**
 * Registers every API route: method, path, access/permission, named `*Http` handler.
 * Product paths follow `/{module}/{file}/{action}/:ids…` (health stays flat).
 * @param {import('fastify').FastifyInstance} app Fastify instance (already prefixed).
 */
export async function registerRoutes(app) {
  // ---------------------------------------------------------------------------
  // http
  // ---------------------------------------------------------------------------

  // health.routes.js

  app.get('/health', withPublicAccess(), getHealthHttp);
  app.get('/readiness', withPublicAccess(), getReadinessHttp);

  // ---------------------------------------------------------------------------
  // end http
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // access
  // ---------------------------------------------------------------------------

  // auth.js

  app.post('/access/auth/login', withPublicAccess(), loginHttp);
  app.post('/access/auth/refresh', withPublicAccess(true), refreshSessionHttp);
  app.post('/access/auth/logout', withPublicAccess(true), logoutHttp);
  app.get('/access/auth/me', withAuthenticatedAccess(true), getCurrentUserHttp);

  // password.js

  app.post('/access/password/change', withAuthenticatedAccess(true), changeOwnPasswordHttp);

  // permissions.js

  app.get('/access/permissions/list', withRequiredPermissions('roles.manage'), listPermissionsHttp);

  // audit.js

  app.get('/access/audit/list', withRequiredPermissions('audit.view'), listAuditEventsHttp);
  app.get('/access/audit/get/:auditEventId', withRequiredPermissions('audit.view'), getAuditEventHttp);

  // ---------------------------------------------------------------------------
  // end access
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // masters
  // ---------------------------------------------------------------------------

  // users.js

  app.post('/masters/users/create', withRequiredPermissions('users.manage', true), createUserHttp);
  app.get('/masters/users/list', withRequiredPermissions('users.manage'), listUsersHttp);
  app.get('/masters/users/get/:userId', withRequiredPermissions('users.manage'), getUserHttp);
  app.patch('/masters/users/update/:userId', withRequiredPermissions('users.manage'), updateUserHttp);
  app.post('/masters/users/activate/:userId', withRequiredPermissions('users.manage'), activateUserHttp);
  app.post('/masters/users/deactivate/:userId', withRequiredPermissions('users.manage'), deactivateUserHttp);
  app.delete('/masters/users/delete/:userId', withRequiredPermissions('users.manage'), deleteUserHttp);
  app.put('/masters/users/replaceRoles/:userId', withRequiredPermissions(['users.manage', 'roles.manage']), replaceUserRolesHttp);
  app.post('/masters/users/resetPassword/:userId', withRequiredPermissions('users.manage'), resetUserPasswordHttp);

  // roles.js

  app.get('/masters/roles/list', withRequiredPermissions('roles.manage'), listRolesHttp);
  app.post('/masters/roles/create', withRequiredPermissions('roles.manage'), createRoleHttp);
  app.patch('/masters/roles/update/:roleId', withRequiredPermissions('roles.manage'), updateRoleHttp);
  app.delete('/masters/roles/delete/:roleId', withRequiredPermissions('roles.manage'), deleteRoleHttp);

  // projects.js

  app.post('/masters/projects/create', withRequiredPermissions('projects.create', true), createProjectHttp);
  app.get('/masters/projects/list', withRequiredPermissions('projects.view'), listProjectsHttp);
  app.get('/masters/projects/get/:projectId', withProjectAccess('projects.view'), getProjectHttp);
  app.post('/masters/projects/recordAccess/:projectId', withProjectAccess('projects.view'), recordProjectAccessHttp);
  app.patch('/masters/projects/update/:projectId', withProjectAccess('projects.update'), updateProjectHttp);
  app.get('/masters/projects/getSettings/:projectId', withProjectAccess('settings.manage'), getProjectSettingsHttp);
  app.patch('/masters/projects/updateSettings/:projectId', withProjectAccess('settings.manage'), updateProjectSettingsHttp);
  app.post('/masters/projects/archive/:projectId', withProjectAccess('projects.update'), archiveProjectHttp);
  app.post('/masters/projects/restore/:projectId', withProjectAccess('projects.update'), restoreProjectHttp);
  app.get('/masters/projects/getDeletionPreview/:projectId', withProjectAccess('projects.delete'), getProjectDeletionPreviewHttp);
  app.delete('/masters/projects/delete/:projectId', withProjectAccess('projects.delete'), deleteProjectHttp);

  // projectMembers.js

  app.get('/masters/projectMembers/list/:projectId', withProjectAccess(['projects.update', 'users.manage']), listProjectMembersHttp);
  app.post('/masters/projectMembers/create/:projectId', withProjectAccess(['projects.update', 'users.manage']), addProjectMemberHttp);
  app.delete('/masters/projectMembers/delete/:projectId/:userId', withProjectAccess(['projects.update', 'users.manage']), removeProjectMemberHttp);

  // jobs.js

  app.post('/masters/jobs/retry/:jobId', withAuthenticatedAccess(false, true), retryJobHttp);
  app.post('/masters/jobs/cancel/:jobId', withAuthenticatedAccess(), cancelJobHttp);
  app.get('/masters/jobs/list/:projectId', withProjectAccess('projects.view'), listProjectJobsHttp);
  app.get('/masters/jobs/get/:jobId', withAuthenticatedAccess(), getJobHttp);

  // notifications.js

  app.get('/masters/notifications/list', withRequiredPermissions('notifications.view'), listNotificationsHttp);
  app.post('/masters/notifications/markRead/:notificationId', withRequiredPermissions('notifications.view'), markNotificationReadHttp);
  app.post('/masters/notifications/markAllRead', withRequiredPermissions('notifications.view'), markAllNotificationsReadHttp);

  // projectActivities.js (usage)

  app.get('/masters/projectActivities/getOrganizationUsage', withRequiredPermissions('usage.view'), getOrganizationUsageHttp);
  app.get('/masters/projectActivities/getProjectUsage/:projectId', withRequiredPermissions('usage.view'), getProjectUsageHttp);
  app.get('/masters/projectActivities/getMyUsage', withAuthenticatedAccess(), getMyUsageHttp);

  // ---------------------------------------------------------------------------
  // end masters
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // knowledge
  // ---------------------------------------------------------------------------

  // uploads.js

  app.post('/knowledge/uploads/upload/:projectId', withProjectAccess('sources.upload', true, true), uploadProjectSourceHttp);

  // sources.js

  app.get('/knowledge/sources/listVersions/:projectId', withProjectAccess('projects.view'), listProjectSourceVersionsHttp);
  app.post('/knowledge/sources/reingest/:projectId/:sourceVersionId', withProjectAccess('knowledge.trigger', true), reingestSourceHttp);

  // sourcePreview.js

  app.get('/knowledge/sourcePreview/readSlice/:projectId', withProjectAccess('sources.preview'), readSourceFileSliceHttp);
  app.get('/knowledge/sourcePreview/getMetadata/:projectId', withProjectAccess('sources.preview'), getSourceFileMetadataHttp);

  // changeSummary.js

  app.get('/knowledge/changeSummary/getLatest/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), getLatestKnowledgeUpdateHttp);

  // repositories.js

  app.post('/knowledge/repositories/probe/:projectId', withProjectAccess('repos.connect'), probeRepositoryHttp);
  app.post('/knowledge/repositories/attach/:projectId', withProjectAccess('repos.connect', true), attachRepositoryHttp);
  app.post('/knowledge/repositories/sync/:projectId', withProjectAccess('repos.connect', true), syncRepositoryHttp);
  app.get('/knowledge/repositories/getConnection/:projectId', withProjectAccess(['projects.view', 'repos.connect']), getRepositoryConnectionHttp);
  app.patch('/knowledge/repositories/updateBranch/:projectId', withProjectAccess('repos.connect'), updateRepositoryBranchHttp);
  app.post('/knowledge/repositories/replaceCredential/:projectId', withProjectAccess('repos.connect'), replaceRepositoryCredentialHttp);
  app.post('/knowledge/repositories/revokeCredential/:projectId', withProjectAccess('repos.connect'), revokeRepositoryCredentialHttp);
  app.post('/knowledge/repositories/retestConnection/:projectId', withProjectAccess('repos.connect'), retestRepositoryConnectionHttp);

  // knowledge.js

  app.get('/knowledge/knowledge/getSummary/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), getKnowledgeSummaryHttp);
  app.get('/knowledge/knowledge/listWorkflows/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), listKnowledgeWorkflowsHttp);
  app.get('/knowledge/knowledge/listApis/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), listKnowledgeApisHttp);
  app.get('/knowledge/knowledge/listSymbols/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), listKnowledgeSymbolsHttp);
  app.get('/knowledge/knowledge/getHealth/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), getKnowledgeHealthHttp);
  app.get('/knowledge/knowledge/getIndex/:projectId', withProjectAccess(['knowledge.browse', 'knowledge.view']), getKnowledgeIndexHttp);

  // search.js

  app.get('/knowledge/search/run/:projectId', withProjectAccess('search.run'), searchProjectHttp);

  // ---------------------------------------------------------------------------
  // end knowledge
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // conversation
  // ---------------------------------------------------------------------------

  // conversation.js

  app.post('/conversation/conversation/create/:projectId', withProjectAccess('chat.ask', true), createConversationHttp);
  app.get('/conversation/conversation/list/:projectId', withProjectAccess('chat.ask'), listConversationsHttp);
  app.get('/conversation/conversation/search/:projectId', withProjectAccess('conversations.search'), searchConversationsHttp);
  app.get('/conversation/conversation/get/:projectId/:conversationId', withProjectAccess('chat.ask'), getConversationHttp);
  app.get('/conversation/conversation/listMessages/:projectId/:conversationId', withProjectAccess('chat.ask'), listConversationMessagesHttp);
  app.patch('/conversation/conversation/rename/:projectId/:conversationId', withProjectAccess('chat.ask'), renameConversationHttp);
  app.post('/conversation/conversation/archive/:projectId/:conversationId', withProjectAccess('conversations.archive'), archiveConversationHttp);
  app.post('/conversation/conversation/restore/:projectId/:conversationId', withProjectAccess('conversations.archive'), restoreConversationHttp);
  app.delete('/conversation/conversation/delete/:projectId/:conversationId', withProjectAccess('conversations.archive'), deleteConversationHttp);

  // chatStream.js

  app.post('/conversation/chatStream/streamMessage/:projectId/:conversationId', withProjectAccess('chat.ask', true), streamConversationMessageHttp);

  // conversationContext.js

  app.get('/conversation/conversationContext/get/:projectId/:conversationId', withProjectAccess('chat.ask'), getConversationContextHttp);

  // ---------------------------------------------------------------------------
  // end conversation
  // ---------------------------------------------------------------------------

  /**
   * Fastify options for public (unauthenticated) routes.
   * @param {boolean} [requireCsrf=false] When true, attach CSRF onRequest from this app.
   * @returns {{ config: { routeAccess: 'public' }, onRequest?: unknown }}
   */
  function withPublicAccess(requireCsrf = false) {
    if (requireCsrf) {
      return { config: { routeAccess: 'public' }, onRequest: app.csrfProtection };
    }
    return { config: { routeAccess: 'public' } };
  }
}

/**
 * Fastify options for authenticated routes without a project preHandler.
 * @param {boolean} [allowWhenMustChangePassword=false] Allow callers who must change password.
 * @param {boolean} [requireIdempotencyKey=false] Require Idempotency-Key header.
 * @returns {{ config: object }}
 */
function withAuthenticatedAccess(allowWhenMustChangePassword = false, requireIdempotencyKey = false) {
  /** @type {Record<string, unknown>} */
  const config = { routeAccess: 'authenticated' };
  if (allowWhenMustChangePassword) {
    config.allowWhenMustChangePassword = true;
  }
  if (requireIdempotencyKey) {
    config.requireIdempotencyKey = true;
  }
  return { config };
}

/**
 * Fastify options for org-scoped `requiredPermissions` routes.
 * @param {string | string[]} permissions Catalog permission key(s).
 * @param {boolean} [requireIdempotencyKey=false] Require Idempotency-Key header.
 * @returns {{ config: { requiredPermissions: string[], requireIdempotencyKey?: boolean } }}
 */
function withRequiredPermissions(permissions, requireIdempotencyKey = false) {
  const requiredPermissions = Array.isArray(permissions) ? permissions : [permissions];
  /** @type {{ requiredPermissions: string[], requireIdempotencyKey?: boolean }} */
  const config = { requiredPermissions };
  if (requireIdempotencyKey) {
    config.requireIdempotencyKey = true;
  }
  return { config };
}

/**
 * Fastify options for authenticated project-scoped routes; builds the ACL preHandler.
 * A string permission requires that key; an array requires any one of the keys.
 * @param {string | string[]} permission Project permission key(s).
 * @param {boolean} [requireIdempotencyKey=false] Require Idempotency-Key header.
 * @param {boolean} [consumeSourceArchive=false] Consume multipart source archive before the handler.
 * @returns {{ config: object, preHandler: import('fastify').preHandlerAsyncHookHandler }}
 */
function withProjectAccess(permission, requireIdempotencyKey = false, consumeSourceArchive = false) {
  /** @type {Record<string, unknown>} */
  const config = { routeAccess: 'authenticated' };
  if (requireIdempotencyKey) {
    config.requireIdempotencyKey = true;
  }
  if (consumeSourceArchive) {
    config.consumeSourceArchive = true;
  }
  const mode = Array.isArray(permission) ? 'any' : 'all';
  return {
    config,
    preHandler: requireProjectPermission(permission, { mode }),
  };
}
