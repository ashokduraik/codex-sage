/**
 * Conditional lease and project-lock refresh for in-flight jobs.
 */
import mongoose from 'mongoose';
import { ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { Job } from '../modules/jobs/job.model.js';
import { refreshProjectJobLock } from './projectJobLock.js';
import { WORKER_LEASE_TTL_MS } from './worker.constants.js';

/**
 * Refreshes heartbeat/lease for a job when workerId still matches.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   leaseTtlMs?: number,
 * }} input Heartbeat inputs.
 * @returns {Promise<boolean>} True when ownership is still held.
 */
export async function refreshJobLease(input) {
  const leaseTtlMs = input.leaseTtlMs ?? WORKER_LEASE_TTL_MS;
  const result = await Job.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          heartbeatAt: '$$NOW',
          leaseExpiresAt: { $add: ['$$NOW', leaseTtlMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { updatePipeline: true },
  ).exec();
  return result.matchedCount > 0;
}

/**
 * Heartbeats one in-flight job: refresh lease, then project lock when exclusive.
 * When the lease refresh matches nothing, ownership was lost — caller should abort.
 * @param {{
 *   jobId: string,
 *   workerId: string,
 *   orgId: string,
 *   projectId: string,
 *   holdsProjectLock: boolean,
 *   leaseTtlMs?: number,
 * }} input Heartbeat context.
 * @returns {Promise<{ owned: boolean }>}
 */
export async function heartbeatInFlightJob(input) {
  const owned = await refreshJobLease({
    jobId: input.jobId,
    workerId: input.workerId,
    leaseTtlMs: input.leaseTtlMs,
  });
  if (!owned) {
    return { owned: false };
  }
  if (input.holdsProjectLock) {
    await refreshProjectJobLock({
      orgId: input.orgId,
      projectId: input.projectId,
      jobId: input.jobId,
      workerId: input.workerId,
      leaseTtlMs: input.leaseTtlMs,
    });
  }
  return { owned: true };
}
