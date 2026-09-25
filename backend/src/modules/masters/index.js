/**
 * Public surface of the masters module (org, users, roles, projects, jobs).
 */
import { userRoutes } from './users.js';
import { roleRoutes } from './roles.js';
import { Job } from '../../models/job.model.js';
import { Organization } from '../../models/organization.model.js';
import { Project } from '../../models/projects.model.js';
import { ProjectMember } from '../../models/projectMembers.model.js';
import { Role } from '../../models/role.model.js';
import { User } from '../../models/user.model.js';

export {
  DEFAULT_ORG_NAME,
  DEFAULT_ORG_SLUG,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_NAME,
  DEFAULT_ADMIN_PASSWORD,
  runBootstrapSeed,
  findOrganizationBySlug,
  findOrganizationById,
  createOrganization,
  softDeleteOrganization,
  bumpOrganizationAclVersion,
} from './organizations.js';
export { Organization, SLUG_PATTERN } from '../../models/organization.model.js';
export { User, USER_STATUS_VALUES, PROJECT_ACCESS_MODE_VALUES } from '../../models/user.model.js';
export { Role, BUILT_IN_ROLES, BUILT_IN_ROLE_KEYS, isBuiltInRoleKey } from '../../models/role.model.js';
export {
  findUserByEmail,
  findUserById,
  createUserInRepo,
  findUserByIdWithPassword,
  findActiveUsersByEmailWithPassword,
  createUser,
  listUsers,
  softDeleteUser,
  updateUser,
  setPasswordHashIfMissing,
  updateUserPasswordHash,
  applyPasswordUpdate,
  touchLastLoginAt,
  IDENTITY_LIST_PAGE_SIZE_DEFAULT,
  IDENTITY_LIST_PAGE_SIZE_MAX,
  clampIdentityListLimit,
  userRoutes,
  replaceUserRoles,
  wouldRemoveLastAdmin,
  isRoleReferencedByActiveUser,
  assertRolesExistInOrg,
} from './users.js';
export {
  findBuiltInRole,
  findRoleById,
  createRoleInRepo,
  findRolesByIds,
  listRoles,
  listRolesPage,
  createRole,
  ensureBuiltInRoles,
  softDeleteRole,
  updateRole,
  isDuplicateKeyError,
  roleRoutes,
} from './roles.js';
export {
  Project,
  LIFECYCLE_STATUS_VALUES,
  KNOWLEDGE_HEALTH_VALUES,
  SOURCE_TYPE_VALUES,
} from '../../models/projects.model.js';
export {
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
  PROJECTS_LIST_SORT_VALUES,
  clampProjectsListLimit,
  resolveProjectsListSort,
  adjustProjectConversationCount,
  createProjectInRepo,
  findProjectById,
  listProjectsInRepo,
  touchProjectLastAccessedAt,
  updateProjectMetadata,
  updateProjectSettings,
  updateProjectSourceConfig,
  conditionalLifecycleUpdate,
  softDeleteProject,
  DELETION_PREVIEW_CONSEQUENCES,
  transitionLifecycle,
  createProject,
  listProjects,
  getProject,
  recordProjectAccess,
  updateProject,
  getProjectSettings,
  patchProjectSettings,
  archiveProject,
  restoreProject,
  getDeletionPreview,
  deleteProject,
  mapProjectToDto,
  PROJECT_SETTING_KEYS,
  isKnownProjectSettingKey,
  validateProjectSettingsKeys,
  projectRoutes,
} from './projects.js';
export { ProjectMember } from '../../models/projectMembers.model.js';
export {
  PROJECT_MEMBERS_LIST_DEFAULT_LIMIT,
  PROJECT_MEMBERS_LIST_MAX_LIMIT,
  clampProjectMembersListLimit,
  findActiveProjectMember,
  findProjectMemberIncludingDeleted,
  listAccessibleProjectIdsForUser,
  listProjectMembers,
  createProjectMember,
  reactivateProjectMember,
  softDeleteProjectMember,
  PROJECT_ACL_CACHE_TTL_MS,
  PROJECT_ACL_CACHE_MAX_ENTRIES,
  createProjectAclCache,
  projectAclCache,
  invalidateProjectAclCache,
  configureProjectAclCache,
  bumpProjectAclVersion,
  PROJECT_ACL_NO_ACCESS,
  resolveProjectPermissions,
  resolveAccessibleProjectFilter,
  mapProjectMemberToDto,
  listMembers,
  addProjectMember,
  removeProjectMember,
  ensureCreatorProjectMember,
  projectMemberRoutes,
} from './projectMembers.js';
export { Job } from '../../models/job.model.js';
export {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_ENQUEUED_MESSAGE,
  JOB_EVENT_CODE_ENQUEUED,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_EVENT_SEVERITY_VALUES,
  JOB_LIST_PAGE_SIZE_DEFAULT,
  JOB_LIST_PAGE_SIZE_MAX,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
  FAILURE_CLASS_VALUES,
  ACTIVE_JOB_STATUSES,
  JOB_CANCEL_GRACE_MS,
  JOB_MAX_USER_RETRIES,
  appendJobEvent,
  assertJobEventMessageLength,
  beginUserRetry,
  cancelQueuedJob,
  clampJobListLimit,
  deferRunningJob,
  findActiveJobForProject,
  findActiveJobForProjectByTypes,
  findActiveJobForSourceVersion,
  findJobById,
  insertPendingJob,
  isKnownJobStatus,
  listEventsForJob,
  listJobsByProject,
  promoteRetryingJobToPending,
  requestRunningJobCancel,
  createPendingJob,
  getJobById,
  listProjectJobs,
  mapJobEventToDto,
  mapJobToDetailDto,
  mapJobToListDto,
  ALLOWED_JOB_TRANSITIONS,
  assertJobTransition,
  cancelJob,
  isAllowedJobTransition,
  retryJob,
  jobRoutes,
  jobControlRoutes,
  INGEST_STAGE_DEFINITIONS,
  JOB_STAGE_CATALOG,
  labelForJobStage,
  listStagesForJobType,
  JOB_EVENT_MESSAGES,
  messageContainsAbsolutePath,
  messageContainsObjectIdShape,
  messageContainsRawErrorFragment,
  renderJobEventMessage,
  describeRetryAvailability,
  resolveJobRetryMode,
  deriveKnowledgeAvailability,
  projectJobProgress,
} from './jobs.js';

/**
 * Registers user and role admin routes.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function identityRoutes(app) {
  await userRoutes(app);
  await roleRoutes(app);
}

/** @deprecated Prefer {@link identityRoutes}; kept for existing unit tests. */
export { identityRoutes as adminPasswordResetRoutes };

export const IDENTITY_MODELS = Object.freeze([Organization, User, Role]);
export const PROJECT_MODELS = Object.freeze([Project]);
export const PROJECT_MEMBER_MODELS = Object.freeze([ProjectMember]);
export const JOB_MODELS = Object.freeze([Job]);
