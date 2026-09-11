/**
 * Public surface of the identity module.
 */
export { BUILT_IN_ROLES, BUILT_IN_ROLE_KEYS, isBuiltInRoleKey } from './builtInRoles.js';
export {
  DEFAULT_ORG_NAME,
  DEFAULT_ORG_SLUG,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_NAME,
} from './bootstrapDefaults.js';
export { Organization, SLUG_PATTERN } from './organization.model.js';
export { User, USER_STATUS_VALUES } from './user.model.js';
export { Role } from './role.model.js';
export { Membership } from './membership.model.js';
export {
  findOrganizationBySlug,
  findOrganizationById,
  createOrganization,
  softDeleteOrganization,
} from './organization.repository.js';
export {
  findUserByEmail,
  findUserById,
  createUser,
  listUsers,
  softDeleteUser,
} from './user.repository.js';
export {
  findBuiltInRole,
  listRoles,
  ensureBuiltInRoles,
  softDeleteRole,
  updateRole,
} from './role.repository.js';
export {
  findMembership,
  createMembership,
  listMemberships,
  softDeleteMembership,
} from './membership.repository.js';
export { runBootstrapSeed } from './bootstrapSeed.js';

import { Membership } from './membership.model.js';
import { Organization } from './organization.model.js';
import { Role } from './role.model.js';
import { User } from './user.model.js';

/** Models whose indexes are synced on development API startup. */
export const IDENTITY_MODELS = Object.freeze([Organization, User, Role, Membership]);
