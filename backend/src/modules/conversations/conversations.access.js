/**
 * Owner-only conversation visibility (ADR 0027).
 */
import mongoose from 'mongoose';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

/**
 * Builds the tenant + owner filter used by every conversation read.
 * `conversations.view` does not expand this set.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId Conversation owner.
 * @returns {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId,
 *   ownerUserId: import('mongoose').Types.ObjectId,
 *   status: string,
 * }}
 */
export function buildOwnConversationFilter(orgId, projectId, userId) {
  return {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    ownerUserId: new mongoose.Types.ObjectId(String(userId)),
    status: ROW_STATUS_ACTIVE,
  };
}
