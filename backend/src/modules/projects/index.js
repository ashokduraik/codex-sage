/**
 * Public surface of the projects module.
 */
export {
  Project,
  LIFECYCLE_STATUS_VALUES,
  KNOWLEDGE_HEALTH_VALUES,
  SOURCE_TYPE_VALUES,
} from './projects.model.js';
export {
  LIFECYCLE_TRANSITIONS,
  WORKER_ONLY_LIFECYCLE_STATUSES,
  PRE_KNOWLEDGE_LIFECYCLE_STATUSES,
  isKnownLifecycleStatus,
  isKnownKnowledgeHealth,
  initialLifecycleAfterCreate,
  assertLifecycleTransitionAllowed,
  assertKnowledgeHealthAllowed,
} from './projects.lifecycle.js';
export {
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_LIMIT,
  clampProjectsListLimit,
  createProject as createProjectInRepo,
  findProjectById,
  listProjects as listProjectsInRepo,
  updateProjectMetadata,
  updateProjectSettings,
  conditionalLifecycleUpdate,
  softDeleteProject,
} from './projects.repository.js';
export {
  DELETION_PREVIEW_CONSEQUENCES,
  transitionLifecycle,
  createProject,
  listProjects,
  getProject,
  updateProject,
  getProjectSettings,
  patchProjectSettings,
  archiveProject,
  restoreProject,
  getDeletionPreview,
  deleteProject,
} from './projects.service.js';
export { mapProjectToDto } from './projects.types.js';
export {
  PROJECT_SETTING_KEYS,
  isKnownProjectSettingKey,
  validateProjectSettingsKeys,
} from './projects.settingsRegistry.js';
export { projectRoutes } from './projects.routes.js';

import { Project } from './projects.model.js';

/** Models whose indexes are synced on development API startup. */
export const PROJECT_MODELS = Object.freeze([Project]);
