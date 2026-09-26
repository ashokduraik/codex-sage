/**
 * Reads embedded job.events for tests — not a production export.
 */
import mongoose from 'mongoose';
import { Job } from '../src/models/job.model.js';

/**
 * Returns a job's events oldest-first, or [] when missing.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} jobId Job id.
 * @returns {Promise<object[]>}
 */
export async function listJobEvents(orgId, jobId) {
  if (!mongoose.isValidObjectId(jobId)) {
    return [];
  }
  const job = await Job.findOne({ _id: jobId, orgId }).select('events').lean().exec();
  const events = [...(job?.events ?? [])];
  events.sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left._id ?? '').localeCompare(String(right._id ?? ''));
  });
  return events;
}
