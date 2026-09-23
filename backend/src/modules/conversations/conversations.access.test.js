/**
 * Owner-only conversation filter unit tests.
 */
import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { buildOwnConversationFilter } from './conversations.access.js';

describe('conversations.access', () => {
  it('always scopes to org, project, owner, and active status', () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const filter = buildOwnConversationFilter(orgId, String(projectId), String(userId));
    expect(filter.orgId).toEqual(orgId);
    expect(String(filter.projectId)).toBe(String(projectId));
    expect(String(filter.ownerUserId)).toBe(String(userId));
    expect(filter.status).toBe(ROW_STATUS_ACTIVE);
  });
});
