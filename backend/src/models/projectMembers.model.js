/**
 * `project_members` — Alice is allowed on this one project.
 * Org membership is not enough when her access mode is "selected";
 * this row is the extra grant (and can add a project role or extra
 * permissions).
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const projectMemberSchema = createBaseSchema({
  // Project she can open, e.g. Payments API
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // User being granted access (Alice)
  userId: { type: ObjectId, ref: 'User', required: true },
  // Optional project role on top of her org roles
  roleId: { type: ObjectId, ref: 'Role', default: null },
  // Extra permission strings for this project only
  permissions: { type: [String], default: () => [] },
  // Admin who added Alice to this project
  addedByUserId: { type: ObjectId, ref: 'User', required: true },
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
