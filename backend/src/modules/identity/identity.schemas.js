/**
 * Zod request schemas for identity admin routes.
 */
import { z } from 'zod';
import {
  IDENTITY_LIST_PAGE_SIZE_DEFAULT,
  IDENTITY_LIST_PAGE_SIZE_MAX,
} from './user.repository.js';

/** ObjectId hex string. */
export const objectIdStringSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a 24-char hex ObjectId');

/** Non-empty role id list. */
export const roleIdsSchema = z.array(objectIdStringSchema).min(1);

/**
 * Create-user body.
 */
export const createUserBodySchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(120),
    roleIds: roleIdsSchema,
  })
  .strict();

/**
 * Patch-user body (at least one field).
 */
export const patchUserBodySchema = z
  .object({
    email: z.string().email().max(320).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    roleIds: roleIdsSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.email !== undefined ||
      body.displayName !== undefined ||
      body.roleIds !== undefined,
    { message: 'at least one of email, displayName, roleIds is required' },
  );

/**
 * Replace roles body.
 */
export const replaceRolesBodySchema = z
  .object({
    roleIds: roleIdsSchema,
  })
  .strict();

/**
 * Create-role body.
 */
export const createRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * Patch-role body.
 */
export const patchRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    permissions: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.permissions !== undefined,
    { message: 'at least one of name, description, permissions is required' },
  );

/**
 * User list query.
 */
export const listUsersQuerySchema = z
  .object({
    q: z.string().min(1).max(200).optional(),
    userStatus: z.enum(['active', 'invited', 'disabled']).optional(),
    roleId: objectIdStringSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

/**
 * Role list query.
 */
export const listRolesQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

/**
 * Path param with userId.
 */
export const userIdParamsSchema = z.object({
  userId: objectIdStringSchema,
});

/**
 * Path param with roleId.
 */
export const roleIdParamsSchema = z.object({
  roleId: objectIdStringSchema,
});

export {
  IDENTITY_LIST_PAGE_SIZE_DEFAULT,
  IDENTITY_LIST_PAGE_SIZE_MAX,
};
