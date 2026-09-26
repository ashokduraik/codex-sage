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
export {
  findBuiltInRole,
  createRoleInRepo,
  ensureBuiltInRoles,
} from './roles.js';
export {
  adjustProjectConversationCount,
  findProjectById,
  updateProjectSourceConfig,
  transitionLifecycle,
  mapProjectToDto,
  projectRoutes,
} from './projects.js';
export {
  configureProjectAclCache,
  resolveProjectPermissions,
  projectMemberRoutes,
} from './projectMembers.js';
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
