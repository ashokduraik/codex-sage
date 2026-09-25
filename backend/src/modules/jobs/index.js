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
  ACTIVE_JOB_STATUSES,
  JOB_CANCEL_GRACE_MS,
  JOB_MAX_USER_RETRIES,
} from './jobs.constants.js';
export { Job } from './job.model.js';
export { JobEvent } from './jobEvent.model.js';
export {
  appendJobEvent,
  assertJobEventMessageLength,
  beginUserRetry,
  cancelQueuedJob,
  clampJobListLimit,
  deferRunningJob,
  findActiveJobForProject,
  findActiveJobForProjectByTypes,
  findActiveJobForSourceVersion,
  findJobById,
  insertPendingJob,
  isKnownJobStatus,
  listEventsForJob,
  listJobsByProject,
  promoteRetryingJobToPending,
  requestRunningJobCancel,
} from './jobs.repository.js';
export {
  createPendingJob,
  getJobById,
  listProjectJobs,
  mapJobEventToDto,
  mapJobToDetailDto,
  mapJobToListDto,
} from './jobs.service.js';
export {
  ALLOWED_JOB_TRANSITIONS,
  assertJobTransition,
  cancelJob,
  isAllowedJobTransition,
  retryJob,
} from './jobControl.service.js';
export { jobRoutes } from './jobs.routes.js';
export { jobControlRoutes } from './jobControl.routes.js';
export {
  INGEST_STAGE_DEFINITIONS,
  JOB_STAGE_CATALOG,
  labelForJobStage,
  listStagesForJobType,
} from './jobStageCatalog.js';
export {
  JOB_EVENT_MESSAGES,
  messageContainsAbsolutePath,
  messageContainsObjectIdShape,
  messageContainsRawErrorFragment,
  renderJobEventMessage,
} from './jobEventCatalog.js';
export { describeRetryAvailability, resolveJobRetryMode } from './jobRetryMode.js';
export { deriveKnowledgeAvailability, projectJobProgress } from './jobProgress.js';

import { Job } from './job.model.js';
import { JobEvent } from './jobEvent.model.js';

/** Models whose indexes are synced on development API startup. */
export const JOB_MODELS = Object.freeze([Job, JobEvent]);
