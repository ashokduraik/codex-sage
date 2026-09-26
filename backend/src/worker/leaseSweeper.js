/**
 * Requeues or fails running jobs whose lease expired (crash recovery).
 */
import { ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { Job } from '../models/job.model.js';
import { failJobLeaseExpired, requeueJobInterrupted } from './jobClaim.js';
import { releaseProjectJobLock } from './projectJobLock.js';
import { computeRetryBackoffMs } from './retryPolicy.js';
import { WORKER_LEASE_EXPIRED_CODE } from './worker.events.js';
import { WORKER_MAX_ATTEMPTS } from './worker.constants.js';

/**
 * Scans for expired leases and requeues or fails each job at most once.
 * @param {{
 *   log?: object,
 * }} [options] Optional logger.
 * @returns {Promise<{ requeued: number, failed: number }>}
 */
export async function sweepExpiredLeases(options = {}) {
  const log = options.log;
  const expired = await Job.aggregate([
    {
      $match: {
        status: ROW_STATUS_ACTIVE,
        jobStatus: 'running',
        $expr: { $lt: ['$leaseExpiresAt', '$$NOW'] },
      },
    },
  ]);

  let requeued = 0;
  let failed = 0;

  for (const job of expired) {
    const maxAttempts = typeof job.maxAttempts === 'number' && job.maxAttempts >= 1 ? job.maxAttempts : WORKER_MAX_ATTEMPTS;
    const attempt = typeof job.attempt === 'number' ? job.attempt : 0;

    try {
      if (attempt < maxAttempts) {
        const delayMs = computeRetryBackoffMs(Math.max(1, attempt));
        const updated = await requeueJobInterrupted({
          jobId: job._id,
          delayMs,
        });
        if (updated) {
          requeued += 1;
          await releaseProjectJobLock({
            orgId: updated.orgId,
            projectId: updated.projectId,
            jobId: updated._id,
          });
          log?.info?.({ jobId: String(updated._id), attempt: updated.attempt }, 'lease expired; job requeued');
        }
      } else {
        const updated = await failJobLeaseExpired({
          jobId: job._id,
          failureCode: WORKER_LEASE_EXPIRED_CODE,
        });
        if (updated) {
          failed += 1;
          await releaseProjectJobLock({
            orgId: updated.orgId,
            projectId: updated.projectId,
            jobId: updated._id,
          });
          log?.info?.({ jobId: String(updated._id), attempt: updated.attempt }, 'lease expired; attempts exhausted');
        }
      }
    } catch (error) {
      log?.error?.(
        {
          jobId: String(job._id),
          errName: error instanceof Error ? error.name : 'Error',
        },
        'lease sweeper failed for job',
      );
    }
  }

  return { requeued, failed };
}
