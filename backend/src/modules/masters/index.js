/**
 * Public surface of the masters module (org, users, roles, projects, jobs).
 */
import { Job } from '../../models/job.model.js';
import { Role } from '../../models/role.model.js';
import { User } from '../../models/user.model.js';
import { Project } from '../../models/projects.model.js';
import { Organization } from '../../models/organization.model.js';

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
  createUserHttp,
  listUsersHttp,
  getUserHttp,
  updateUserHttp,
  activateUserHttp,
  deactivateUserHttp,
  deleteUserHttp,
  replaceUserRolesHttp,
  resetUserPasswordHttp,
} from './users.js';
export {
  ADMIN_ROLE_CODE,
  findRoleByCode,
  createRoleInRepo,
  ensureAdminRole,
  listRolesHttp,
  createRoleHttp,
  updateRoleHttp,
  deleteRoleHttp,
} from './roles.js';
export {
  adjustProjectConversationCount,
  findProjectById,
  updateProjectSourceConfig,
  transitionLifecycle,
  mapProjectToDto,
  createProjectHttp,
  listProjectsHttp,
  getProjectHttp,
  recordProjectAccessHttp,
  updateProjectHttp,
  getProjectSettingsHttp,
  updateProjectSettingsHttp,
  archiveProjectHttp,
  restoreProjectHttp,
  getProjectDeletionPreviewHttp,
  deleteProjectHttp,
} from './projects.js';
export {
  configureProjectAclCache,
  resolveProjectPermissions,
  listProjectMembersHttp,
  addProjectMemberHttp,
  removeProjectMemberHttp,
} from './projectMembers.js';
export {
  listNotificationsHttp,
  markNotificationReadHttp,
  markAllNotificationsReadHttp,
  emitProjectNotification,
  emitNotificationsForJobTerminal,
} from './notifications.js';
export {
  getOrganizationUsageHttp,
  getProjectUsageHttp,
  getMyUsageHttp,
  recordProjectActivity,
  recordProjectActivitiesForJobTerminal,
} from './projectActivities.js';
export {
  appendJobEvent,
  deferRunningJob,
  findActiveJobForProjectByTypes,
  findActiveJobForSourceVersion,
  insertPendingJob,
  createPendingJob,
  retryJobHttp,
  cancelJobHttp,
  listProjectJobsHttp,
  getJobHttp,
  renderJobEventMessage,
} from './jobs.js';

export const IDENTITY_MODELS = Object.freeze([Organization, User, Role]);
export const PROJECT_MODELS = Object.freeze([Project]);
export const JOB_MODELS = Object.freeze([Job]);
export { NOTIFICATION_MODELS } from './notifications.js';
export { PROJECT_ACTIVITY_MODELS } from './projectActivities.js';
