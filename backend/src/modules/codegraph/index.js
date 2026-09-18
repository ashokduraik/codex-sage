/**
 * Public surface of the CodeGraph adapter module (sole import site for the library).
 */
export {
  createCodegraphAdapter,
  isCodegraphLoadable,
  mapCodegraphLibraryError,
  CODEGRAPH_MAX_SYNC_RETRY_ATTEMPTS,
} from './codegraph.adapter.js';
export {
  configureCodegraphTelemetryOff,
  isCodegraphTelemetryConfigured,
  CODEGRAPH_TELEMETRY_ENV_KEYS,
} from './codegraph.telemetry.js';
export {
  acquireWriter,
  buildWriterLockKey,
  resetWriterLocksForTests,
} from './codegraph.writerLock.js';
export {
  validateCodegraphIndex,
  CODEGRAPH_VALIDATION_PROBE_TIMEOUT_MS,
} from './codegraph.validate.js';
export {
  resolveCodegraphDir,
  codegraphIndexExists,
  writeCodegraphExcludeConfig,
  CODEGRAPH_DIR_NAME,
  CODEGRAPH_PROJECT_CONFIG_FILENAME,
} from './codegraph.paths.js';
