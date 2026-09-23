/**
 * Worker-only scan that enqueues due `repo_sync` jobs.
 */
import { insertPendingJob, findActiveJobForProjectByTypes } from '../../jobs/index.js';
import { listDueConnections, updateConnection } from '../repositories.repository.js';
import { isProjectSyncBlocked } from './repoSync.service.js';
import { REPO_SYNC_INTERVAL_MS } from './repoSync.constants.js';

/**
 * Enqueues `repo_sync` for each due active connection that is not overlapping.
 * @param {{
 *   now?: Date,
 *   log?: { error?: Function, info?: Function },
 *   listDue?: typeof listDueConnections,
 * }} [input] Optional seams.
 * @returns {Promise<{ enqueued: number, skipped: number }>}
 */
export async function enqueueDueRepositorySyncs(input = {}) {
  const now = input.now ?? new Date();
  const listDue = input.listDue ?? listDueConnections;
  const due = await listDue(now);
  let enqueued = 0;
  let skipped = 0;

  for (const connection of due) {
    const orgId = String(connection.orgId);
    const projectId = String(connection.projectId);
    try {
      const existing = await findActiveJobForProjectByTypes(orgId, projectId, ['repo_sync']);
      if (existing) {
        skipped += 1;
        continue;
      }
      const blocked = await isProjectSyncBlocked({ orgId, projectId });
      if (blocked) {
        skipped += 1;
        continue;
      }
      const { job } = await insertPendingJob({
        orgId,
        projectId,
        jobType: 'repo_sync',
        createdBy: null,
        scheduledAt: now,
      });
      await updateConnection({
        orgId,
        connectionId: String(connection._id),
        set: {
          lastSyncJobId: job._id,
          nextDueAt: new Date(now.getTime() + REPO_SYNC_INTERVAL_MS),
        },
      });
      enqueued += 1;
    } catch (err) {
      skipped += 1;
      input.log?.error?.(
        {
          orgId,
          projectId,
          errName: err instanceof Error ? err.name : 'Error',
        },
        'repo_sync scheduler failed for connection',
      );
    }
  }

  if (enqueued > 0) {
    input.log?.info?.({ enqueued, skipped }, 'repo_sync scheduler enqueued due work');
  }
  return { enqueued, skipped };
}
