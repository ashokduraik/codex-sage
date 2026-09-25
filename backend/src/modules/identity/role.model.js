/**
 * Role Mongoose model — built-in and custom roles per organization.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

/** @typedef {'org_admin' | 'project_admin' | 'member' | 'viewer'} BuiltInRoleKey */

/**
 * Ordered built-in roles for every organization.
 * Permission arrays are resolved from code in the authorization module (empty in Mongo).
 * @type {ReadonlyArray<{ key: BuiltInRoleKey, name: string, description: string }>}
 */
export const BUILT_IN_ROLES = Object.freeze([
  Object.freeze({
    key: 'org_admin',
    name: 'Org Admin',
    description: 'Full organization administration.',
  }),
  Object.freeze({
    key: 'project_admin',
    name: 'Project Admin',
    description: 'Administer projects within the organization.',
  }),
  Object.freeze({
    key: 'member',
    name: 'Member',
    description: 'Standard member access.',
  }),
  Object.freeze({
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access.',
  }),
]);

/** Allowed built-in role keys. */
export const BUILT_IN_ROLE_KEYS = Object.freeze(BUILT_IN_ROLES.map((role) => role.key));

/**
 * Returns whether `key` is one of the four built-in role keys.
 * @param {string} key Candidate key.
 * @returns {boolean}
 */
export function isBuiltInRoleKey(key) {
  return BUILT_IN_ROLE_KEYS.includes(/** @type {BuiltInRoleKey} */ (key));
}

const roleSchema = createBaseSchema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
  },
  description: {
    type: String,
    trim: true,
    default: undefined,
  },
  isBuiltIn: {
    type: Boolean,
    required: true,
    default: false,
  },
  builtInKey: {
    type: String,
    default: undefined,
  },
  permissions: {
    type: [String],
    default: () => [],
  },
});

roleSchema.pre('validate', function validateBuiltInRoleShape() {
  if (this.isBuiltIn) {
    if (!isBuiltInRoleKey(this.builtInKey)) {
      throw new Error(
        'builtInKey must be one of the four built-in keys when isBuiltIn is true',
      );
    }
    return;
  }
  if (this.builtInKey !== undefined && this.builtInKey !== null && this.builtInKey !== '') {
    throw new Error('builtInKey is only allowed on built-in roles');
  }
});

roleSchema.index(
  { orgId: 1, name: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
roleSchema.index(
  { orgId: 1, builtInKey: 1 },
  {
    unique: true,
    partialFilterExpression: { isBuiltIn: true, status: ROW_STATUS_ACTIVE },
  },
);
roleSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });

export const Role =
  mongoose.models.Role ?? mongoose.model('Role', roleSchema, 'roles');
