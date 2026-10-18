/**
 * Organization usage HTTP calls for the admin usage page.
 * Reads observed rollups only — never invents question or token counts.
 */
import { apiRequest } from '@/shared/api';

/**
 * @typedef {{
 *   questionsAnswered?: number,
 *   tokensInput?: number,
 *   tokensOutput?: number,
 *   ingestJobsCompleted?: number,
 *   sourceBytesAccepted?: number,
 *   searchesExecuted?: number,
 * }} UsageTotals
 */

/**
 * Query key for org usage in a date window.
 * @param {{ from?: string, to?: string }} [window] Optional ISO bounds.
 * @returns {readonly unknown[]}
 */
export function organizationUsageQueryKey(window = {}) {
  return Object.freeze(['usage', 'organization', window.from ?? null, window.to ?? null]);
}

/**
 * Loads organization usage for an optional UTC window.
 * @param {{
 *   from?: string,
 *   to?: string,
 *   signal?: AbortSignal,
 * }} [options] Optional window and abort.
 * @returns {Promise<{
 *   period: { from: string, to: string },
 *   totals: UsageTotals,
 *   byProject: Array<UsageTotals & { projectId: string }>,
 *   byUser: Array<UsageTotals & { userId: string }>,
 * }>}
 */
export async function fetchOrganizationUsage(options = {}) {
  const params = new URLSearchParams();
  if (options.from) {
    params.set('from', options.from);
  }
  if (options.to) {
    params.set('to', options.to);
  }
  const query = params.toString();
  const path = query ? `/masters/projectActivities/getOrganizationUsage?${query}` : '/masters/projectActivities/getOrganizationUsage';
  return apiRequest(path, { signal: options.signal });
}
