/**
 * Public surface of the workspace module (materialized project trees).
 */
export {
  resolveProjectWorkspacePath,
  resolveSafeWorkspaceFilePath,
  assertPathInsideRoot,
} from './workspacePaths.js';
export {
  resetProjectWorkspaceSubtree,
  deleteWorkspaceRelativePath,
  materializeGridFsFileToDisk,
} from './workspaceMaterialize.js';
