/**
 * Public surface of the projectMembers module.
 */
export { ProjectMember } from './projectMembers.model.js';
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
} from './projectMembers.repository.js';
export {
  PROJECT_ACL_CACHE_TTL_MS,
  PROJECT_ACL_CACHE_MAX_ENTRIES,
  createProjectAclCache,
  projectAclCache,
  invalidateProjectAclCache,
  configureProjectAclCache,
  bumpProjectAclVersion,
} from './projectAclCache.js';
export {
  PROJECT_ACL_NO_ACCESS,
  resolveProjectPermissions,
  resolveAccessibleProjectFilter,
} from './projectAccess.js';
export {
  mapProjectMemberToDto,
  listMembers,
  addProjectMember,
  removeProjectMember,
  ensureCreatorProjectMember,
} from './projectMembers.service.js';
export { projectMemberRoutes } from './projectMembers.routes.js';

import { ProjectMember } from './projectMembers.model.js';

/** Models whose indexes are synced on development API startup. */
export const PROJECT_MEMBER_MODELS = Object.freeze([ProjectMember]);
