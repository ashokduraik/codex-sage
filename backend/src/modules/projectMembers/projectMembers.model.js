/**
 * ProjectMember Mongoose model — per-project ACL overlay (solution §8.1).
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

const projectMemberSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  roleId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  permissions: {
    type: [String],
    default: () => [],
  },
  addedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
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
