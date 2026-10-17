/**
 * Organization usage HTTP calls for the admin usage page.
 * Reads observed rollups only — never invents question or token counts.
 */
import { apiRequest } from '@/shared/api';

/**
 * @typedef {{
 *   ingestJobsCompleted: number,
 *   sourceBytesAccepted: number,
 *   searchesExecuted: number,
 * }} UsageTotals
 */

/**
 * Query key for org usage.
 * @returns {readonly unknown[]}
 */
export function organizationUsageQueryKey() {
  return Object.freeze(['usage', 'organization']);
}

/**
 * Loads organization usage for the default window.
 * @param {{ signal?: AbortSignal }} [options] Optional abort.
 * @returns {Promise<{
 *   period: { from: string, to: string },
 *   totals: UsageTotals,
 *   byProject: Array<UsageTotals & { projectId: string }>,
 *   byUser: Array<UsageTotals & { userId: string }>,
 * }>}
 */
export async function fetchOrganizationUsage(options = {}) {
  return apiRequest('/masters/projectActivities/getOrganizationUsage', { signal: options.signal });
}
