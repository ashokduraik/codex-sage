/**
 * Acquire / refresh / release project writer locks for exclusive job types.
 */
import mongoose from 'mongoose';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../platform/data/index.js';
import { ProjectJobLock } from './projectJobLock.model.js';
import { PROJECT_JOB_LOCK_SCOPE, WORKER_LEASE_TTL_MS } from './worker.constants.js';

/**
 * Returns true when an error is a Mongo duplicate-key conflict.
 * @param {unknown} error Candidate error.
 * @returns {boolean}
 */
function isDuplicateKeyError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      /** @type {{ code?: number }} */ (error).code === 11000,
  );
}

/**
 * Tries to acquire the project writer lock for a claimed job.
 * Succeeds when no live lock exists or the existing lock's expiresAt has passed (server time).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   leaseTtlMs?: number,
 * }} input Lock identity.
 * @returns {Promise<{ acquired: boolean }>}
 */
export async function acquireProjectJobLock(input) {
  const orgId = new mongoose.Types.ObjectId(String(input.orgId));
  const projectId = new mongoose.Types.ObjectId(String(input.projectId));
  const jobId = new mongoose.Types.ObjectId(String(input.jobId));
  const leaseTtlMs = input.leaseTtlMs ?? WORKER_LEASE_TTL_MS;
  const workerId = input.workerId;

  try {
    const created = await ProjectJobLock.create({
      orgId,
      projectId,
      jobId,
      workerId,
      lockScope: PROJECT_JOB_LOCK_SCOPE,
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + leaseTtlMs),
    });
    // Align expiry to server time after insert (create cannot use $$NOW).
    await ProjectJobLock.updateOne(
      { _id: created._id },
      [
        {
          $set: {
            acquiredAt: '$$NOW',
            expiresAt: { $add: ['$$NOW', leaseTtlMs] },
          },
        },
      ],
      { updatePipeline: true },
    );
    return { acquired: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  // Same job already holds the lock (retry after transient error) — treat as acquired.
  const existing = await ProjectJobLock.findOne({
    orgId,
    projectId,
    lockScope: PROJECT_JOB_LOCK_SCOPE,
    status: ROW_STATUS_ACTIVE,
    jobId,
  }).exec();
  if (existing && existing.workerId === workerId) {
    await refreshProjectJobLock({ orgId, projectId, jobId, workerId, leaseTtlMs });
    return { acquired: true };
  }

  // Take over when the live lock is expired (server clock).
  const taken = await ProjectJobLock.findOneAndUpdate(
    {
      orgId,
      projectId,
      lockScope: PROJECT_JOB_LOCK_SCOPE,
      status: ROW_STATUS_ACTIVE,
      $expr: { $lt: ['$expiresAt', '$$NOW'] },
    },
    [
      {
        $set: {
          jobId,
          workerId,
          acquiredAt: '$$NOW',
          expiresAt: { $add: ['$$NOW', leaseTtlMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  return { acquired: Boolean(taken) };
}

/**
 * Refreshes lock expiry when the holder still matches jobId + workerId.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   leaseTtlMs?: number,
 * }} input Lock identity.
 * @returns {Promise<boolean>} True when a document was updated.
 */
export async function refreshProjectJobLock(input) {
  const leaseTtlMs = input.leaseTtlMs ?? WORKER_LEASE_TTL_MS;
  const result = await ProjectJobLock.updateOne(
    {
      orgId: new mongoose.Types.ObjectId(String(input.orgId)),
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      jobId: new mongoose.Types.ObjectId(String(input.jobId)),
      workerId: input.workerId,
      lockScope: PROJECT_JOB_LOCK_SCOPE,
      status: ROW_STATUS_ACTIVE,
    },
    [
      {
        $set: {
          expiresAt: { $add: ['$$NOW', leaseTtlMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { updatePipeline: true },
  ).exec();
  return result.modifiedCount > 0 || result.matchedCount > 0;
}

/**
 * Releases the lock held by a specific job (soft-delete so the unique key frees).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobId: import('mongoose').Types.ObjectId | string,
 * }} input Lock identity.
 * @returns {Promise<boolean>} True when a lock was released.
 */
export async function releaseProjectJobLock(input) {
  const result = await ProjectJobLock.updateOne(
    {
      orgId: new mongoose.Types.ObjectId(String(input.orgId)),
      projectId: new mongoose.Types.ObjectId(String(input.projectId)),
      jobId: new mongoose.Types.ObjectId(String(input.jobId)),
      lockScope: PROJECT_JOB_LOCK_SCOPE,
      status: ROW_STATUS_ACTIVE,
    },
    [
      {
        $set: {
          status: ROW_STATUS_DELETED,
          updatedAt: '$$NOW',
        },
      },
    ],
    { updatePipeline: true },
  ).exec();
  return result.modifiedCount > 0 || result.matchedCount > 0;
}

/**
 * Returns true when a live (unexpired) project writer lock exists for the project.
 * Used by the Q&A gate — does not acquire or refresh a lock.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 * }} input Project scope.
 * @returns {Promise<boolean>}
 */
export async function hasActiveProjectWriterLock(input) {
  if (
    !mongoose.isValidObjectId(String(input.orgId)) ||
    !mongoose.isValidObjectId(String(input.projectId))
  ) {
    return false;
  }
  const found = await ProjectJobLock.findOne({
    orgId: new mongoose.Types.ObjectId(String(input.orgId)),
    projectId: new mongoose.Types.ObjectId(String(input.projectId)),
    lockScope: PROJECT_JOB_LOCK_SCOPE,
    status: ROW_STATUS_ACTIVE,
    $expr: { $gt: ['$expiresAt', '$$NOW'] },
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return Boolean(found);
}
