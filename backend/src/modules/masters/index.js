/**
 * Public surface of the masters module (org, users, roles, projects, jobs).
 */
import { userRoutes } from './users.js';
import { roleRoutes } from './roles.js';
import { Job } from '../../models/job.model.js';
import { Organization } from '../../models/organization.model.js';
import { Project } from '../../models/projects.model.js';
import { Role } from '../../models/role.model.js';
import { User } from '../../models/user.model.js';

export {
  DEFAULT_ORG_SLUG,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  runBootstrapSeed,
  findOrganizationBySlug,
  createOrganization,
  bumpOrganizationAclVersion,
} from './organizations.js';
export {
  findUserByEmail,
  findUserById,
  createUserInRepo,
  findUserByIdWithPassword,
  findActiveUsersByEmailWithPassword,
  createUser,
  softDeleteUser,
  updateUser,
  updateUserPasswordHash,
  applyPasswordUpdate,
  touchLastLoginAt,
} from './users.js';
export { findBuiltInRole, createRoleInRepo, ensureBuiltInRoles } from './roles.js';
export {
  adjustProjectConversationCount,
  findProjectById,
  updateProjectSourceConfig,
  transitionLifecycle,
  mapProjectToDto,
  projectRoutes,
} from './projects.js';
export { configureProjectAclCache, resolveProjectPermissions, projectMemberRoutes } from './projectMembers.js';
export { notificationRoutes, emitProjectNotification, emitNotificationsForJobTerminal } from './notifications.js';
export { usageRoutes, recordProjectActivity, recordProjectActivitiesForJobTerminal } from './projectActivities.js';
export {
  retentionHandlerRegistration,
  enqueueDueRetentionJobs,
  RETENTION_SCHEDULER_TICK_MS,
  RETENTION_READY_SOURCE_VERSIONS_KEEP,
  RETENTION_JOB_DAYS,
  RETENTION_NOTIFICATION_DAYS,
  RETENTION_NOTIFICATION_READ_DAYS,
  RETENTION_USAGE_DAYS,
  RETENTION_CONVERSATION_DAYS,
  RETENTION_AUDIT_DAYS,
} from './retention.js';
export {
  appendJobEvent,
  deferRunningJob,
  findActiveJobForProjectByTypes,
  findActiveJobForSourceVersion,
  insertPendingJob,
  createPendingJob,
  jobRoutes,
  renderJobEventMessage,
} from './jobs.js';

/**
 * Registers user and role admin routes.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function identityRoutes(app) {
  await userRoutes(app);
  await roleRoutes(app);
}

export const IDENTITY_MODELS = Object.freeze([Organization, User, Role]);
export const PROJECT_MODELS = Object.freeze([Project]);
export const JOB_MODELS = Object.freeze([Job]);
export { NOTIFICATION_MODELS } from './notifications.js';
export { PROJECT_ACTIVITY_MODELS } from './projectActivities.js';
