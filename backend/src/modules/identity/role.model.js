/**
 * Role Mongoose model — built-in and custom roles per organization.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { isBuiltInRoleKey } from './builtInRoles.js';

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

export const Role =
  mongoose.models.Role ?? mongoose.model('Role', roleSchema, 'roles');
