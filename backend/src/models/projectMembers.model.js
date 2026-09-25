/**
 * `project_members` — per-project access overlay on top of org membership.
 * Grants or restricts a user on one project via a role and extra permissions.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const projectMemberSchema = createBaseSchema({
  // Project this ACL overlay applies to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // User granted or restricted on this project
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Optional project-scoped role layered on org membership
  roleId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Extra or replacement permission strings for this project
  permissions: { type: [String], default: () => [] },
  // Admin who added this membership overlay
  addedByUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
});

projectMemberSchema.index(
  { orgId: 1, projectId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
projectMemberSchema.index(
  { orgId: 1, userId: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
projectMemberSchema.index(
  { orgId: 1, projectId: 1, createdAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const ProjectMember =
  mongoose.models.ProjectMember ??
  mongoose.model('ProjectMember', projectMemberSchema, 'project_members');
