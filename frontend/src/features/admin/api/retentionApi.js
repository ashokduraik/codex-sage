/**
 * Admin retention policy HTTP calls and React Query keys.
 */
import { apiRequest } from '@/shared/api';

/** Query key for GET retention policy. */
export const ADMIN_RETENTION_POLICY_QUERY_KEY = Object.freeze(['admin', 'retentionPolicy']);

/**
 * Loads the effective organization retention policy.
 * @param {{ signal?: AbortSignal }} [options] Request options.
 * @returns {Promise<{
 *   readySourceVersionsKeep: number,
 *   jobDays: number,
 *   notificationDays: number,
 *   notificationReadDays: number,
 *   usageDays: number,
 *   conversationDays: number,
 *   auditDays: number,
 * }>}
 */
export async function fetchRetentionPolicy(options = {}) {
  return apiRequest('/masters/organizations/getRetentionPolicy', { signal: options.signal });
}

/**
 * Patches organization retention windows (requires org.manage).
 * @param {{
 *   readySourceVersionsKeep?: number,
 *   jobDays?: number,
 *   notificationDays?: number,
 *   notificationReadDays?: number,
 *   usageDays?: number,
 *   conversationDays?: number,
 *   auditDays?: number,
 *   idempotencyKey: string,
 * }} input Patch body plus idempotency key.
 * @returns {Promise<object>} Updated effective policy.
 */
export async function updateRetentionPolicy(input) {
  const { idempotencyKey, ...body } = input;
  return apiRequest('/masters/organizations/updateRetentionPolicy', {
    method: 'PATCH',
    body,
    idempotencyKey,
  });
}
