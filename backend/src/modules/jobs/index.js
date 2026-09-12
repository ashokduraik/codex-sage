/**
 * Public surface of the jobs module.
 */
export {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_ENQUEUED_MESSAGE,
  JOB_EVENT_CODE_ENQUEUED,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_EVENT_SEVERITY_VALUES,
  JOB_LIST_PAGE_SIZE_DEFAULT,
  JOB_LIST_PAGE_SIZE_MAX,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
  FAILURE_CLASS_VALUES,
} from './jobs.constants.js';
export { Job } from './job.model.js';
export { JobEvent } from './jobEvent.model.js';
export {
  appendJobEvent,
  assertJobEventMessageLength,
  clampJobListLimit,
  findJobById,
  insertPendingJob,
  isKnownJobStatus,
  listEventsForJob,
  listJobsByProject,
} from './jobs.repository.js';
export { createPendingJob, getJobById, listProjectJobs } from './jobs.service.js';
export { mapJobEventToDto, mapJobToDetailDto, mapJobToListDto } from './jobs.types.js';
export { jobRoutes } from './jobs.routes.js';

import { Job } from './job.model.js';
import { JobEvent } from './jobEvent.model.js';

/** Models whose indexes are synced on development API startup. */
export const JOB_MODELS = Object.freeze([Job, JobEvent]);
