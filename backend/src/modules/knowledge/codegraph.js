/**
 * knowledge/codegraph.js — merged resource file.
 */
import { hasActiveProjectWriterLock } from '../../worker/projectJobLock.js';
import { assertPathInsideRoot } from './sources.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// --- from codegraph/codegraph.paths.js ---
/**
 * Tenant-safe paths for the on-disk `.codegraph` index under a project workspace.
 */
/** Default CodeGraph data directory name (library default; CODEGRAPH_DIR override not used). */
export const CODEGRAPH_DIR_NAME = '.codegraph';

/** Project-scoped exclusion config filename written before index/sync. */
export const CODEGRAPH_PROJECT_CONFIG_FILENAME = 'codegraph.json';

/**
 * Resolves the absolute `.codegraph` directory under a workspace and asserts it stays inside.
 * @param {string} workspacePath Absolute project workspace directory.
 * @returns {string} Absolute graph directory path.
 */
export function resolveCodegraphDir(workspacePath) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const graphDir = path.resolve(resolvedWorkspace, CODEGRAPH_DIR_NAME);
  assertPathInsideRoot(resolvedWorkspace, graphDir);
  return graphDir;
}

/**
 * Returns true when a CodeGraph index directory already exists under the workspace.
 * @param {string} workspacePath Absolute project workspace directory.
 * @returns {Promise<boolean>}
 */
export async function codegraphIndexExists(workspacePath) {
  const graphDir = resolveCodegraphDir(workspacePath);
  try {
    const stats = await fs.stat(graphDir);
    return stats.isDirectory();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Writes `codegraph.json` exclude patterns so S2-excluded paths are not indexed.
 * @param {string} workspacePath Absolute project workspace.
 * @param {string[]} excludedRelativePaths Repo-relative paths marked excludedFromGraph.
 * @returns {Promise<void>}
 */
export async function writeCodegraphExcludeConfig(workspacePath, excludedRelativePaths) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const configPath = path.resolve(resolvedWorkspace, CODEGRAPH_PROJECT_CONFIG_FILENAME);
  assertPathInsideRoot(resolvedWorkspace, configPath);

  const exclude = [...new Set(excludedRelativePaths.filter((p) => typeof p === 'string' && p.length > 0))];
  const body = `${JSON.stringify({ exclude }, null, 2)}\n`;
  await fs.writeFile(configPath, body, 'utf8');
}

// --- from codegraph/codegraph.writerLock.js ---
/**
 * In-process per-project CodeGraph writer mutex (queues same-key acquirers).
 * Complements ADR 0022 project_job_locks; does not replace them.
 */

/** @type {Map<string, Promise<void>>} */
const projectWriterTails = new Map();

/** Keys currently held by an in-process writer (not merely queued). */
const heldWriterKeys = new Set();

/**
 * Builds a stable lock key for a tenant project.
 * @param {{ orgId: string, projectId: string }} scope Org + project ids.
 * @returns {string}
 */
export function buildWriterLockKey(scope) {
  return `${String(scope.orgId)}:${String(scope.projectId)}`;
}

/**
 * Acquires the in-process writer lock for a project (FIFO queue).
 * @param {{ orgId: string, projectId: string }} scope Org + project ids.
 * @returns {Promise<() => void>} Release function (call once in finally).
 */
export async function acquireWriter(scope) {
  const key = buildWriterLockKey(scope);
  const previous = projectWriterTails.get(key) ?? Promise.resolve();

  let releaseCurrent = () => {};
  const held = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  const tail = previous.then(() => held);
  projectWriterTails.set(
    key,
    tail.then(
      () => undefined,
      () => undefined,
    ),
  );

  await previous;
  heldWriterKeys.add(key);

  let released = false;
  return function releaseWriter() {
    if (released) {
      return;
    }
    released = true;
    heldWriterKeys.delete(key);
    releaseCurrent();
  };
}

const acquireProjectWriter = acquireWriter;

/**
 * True when this process currently holds the writer mutex for the project.
 * @param {{ orgId: string, projectId: string }} scope Org + project ids.
 * @returns {boolean}
 */
export function isWriterHeld(scope) {
  return heldWriterKeys.has(buildWriterLockKey(scope));
}

/**
 * Test helper — clears all writer lock queues.
 * @returns {void}
 */
export function resetWriterLocksForTests() {
  projectWriterTails.clear();
  heldWriterKeys.clear();
}

// --- from codegraph/codegraph.validate.js ---
/**
 * Post-index validation probes for S4 (index health + exclusion accounting).
 */

/** Wall-clock budget per validation probe. */
export const CODEGRAPH_VALIDATION_PROBE_TIMEOUT_MS = 15_000;

/**
 * Runs a probe with a wall-clock timeout.
 * @param {string} name Probe name.
 * @param {() => Promise<unknown> | unknown} run Probe body.
 * @param {number} [timeoutMs] Cap in ms.
 * @returns {Promise<{ name: string, passed: boolean, detail?: string }>}
 */
async function runProbe(name, run, timeoutMs = CODEGRAPH_VALIDATION_PROBE_TIMEOUT_MS) {
  let timeoutId;
  try {
    await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Probe ${name} timed out`));
        }, timeoutMs);
      }),
    ]);
    return { name, passed: true };
  } catch (err) {
    return {
      name,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Validates a CodeGraph instance after index/sync.
 * @param {{
 *   graph: {
 *     getIndexState: () => string | null,
 *     getStats: () => { fileCount: number, nodeCount: number, dbSizeBytes?: number, lastUpdated?: number },
 *     isWatching?: () => boolean,
 *     getProjectRoot?: () => string,
 *   },
 *   expectedIndexedFileCount: number,
 *   expectedExcludedCount: number,
 *   graphPath: string,
 *   sourceVersionId: string,
 *   mode: 'indexAll' | 'sync',
 *   indexedFileCount: number,
 *   skippedFileCount: number,
 *   graphHash?: string | null,
 *   now?: () => Date,
 * }} input Validation inputs from the adapter.
 * @returns {Promise<{
 *   ok: boolean,
 *   hardFail: boolean,
 *   identity: {
 *     graphPath: string,
 *     graphHash: string | null,
 *     indexedAt: string,
 *     sourceVersionId: string,
 *     indexedFileCount: number,
 *     skippedFileCount: number,
 *     mode: 'indexAll' | 'sync',
 *   },
 *   coverage: { indexedFiles: number, skippedFiles: number, expectedIndexed: number, expectedExcluded: number },
 *   probes: Array<{ name: string, passed: boolean, detail?: string }>,
 * }>}
 */
export async function validateCodegraphIndex(input) {
  const now = input.now ?? (() => new Date());
  const probes = [];

  probes.push(
    await runProbe('index_dir_present', () => {
      if (!input.graphPath) {
        throw new Error('graphPath missing');
      }
    }),
  );

  probes.push(
    await runProbe('index_state_healthy', async () => {
      const state = await Promise.resolve(input.graph.getIndexState());
      if (state === 'failed' || state === 'indexing') {
        throw new Error(`index state is ${state}`);
      }
      // null (legacy) and complete/partial are acceptable; partial is expected with exclusions.
      if (state === 'partial' && input.expectedExcludedCount === 0 && input.skippedFileCount === 0) {
        throw new Error('index reported partial without exclusions or skips');
      }
    }),
  );

  probes.push(
    await runProbe('watcher_off', async () => {
      const watching = await Promise.resolve(
        typeof input.graph.isWatching === 'function' ? input.graph.isWatching() : false,
      );
      if (watching) {
        throw new Error('filesystem watcher is active');
      }
    }),
  );

  probes.push(
    await runProbe('stats_readable', async () => {
      const stats = await Promise.resolve(input.graph.getStats());
      if (!stats || typeof stats.fileCount !== 'number') {
        throw new Error('getStats returned no fileCount');
      }
    }),
  );

  probes.push(
    await runProbe('exclusion_accounting', () => {
      // Soft check: skipped + indexed should not under-count expected graph candidates
      // when the library reports both; hard-fail only when indexed exceeds candidates.
      if (input.indexedFileCount > input.expectedIndexedFileCount) {
        throw new Error('indexed more files than non-excluded candidates');
      }
    }),
  );

  const hardFail = probes.some((p) => !p.passed && p.name !== 'exclusion_accounting');
  const softFail = probes.some((p) => !p.passed);
  const ok = !softFail;

  return {
    ok,
    hardFail: hardFail || (!ok && probes.some((p) => p.name === 'index_state_healthy' && !p.passed)),
    identity: {
      graphPath: input.graphPath,
      graphHash: input.graphHash ?? null,
      indexedAt: now().toISOString(),
      sourceVersionId: String(input.sourceVersionId),
      indexedFileCount: input.indexedFileCount,
      skippedFileCount: input.skippedFileCount,
      mode: input.mode,
    },
    coverage: {
      indexedFiles: input.indexedFileCount,
      skippedFiles: input.skippedFileCount,
      expectedIndexed: input.expectedIndexedFileCount,
      expectedExcluded: input.expectedExcludedCount,
    },
    probes,
  };
}

// --- from codegraph/codegraph.adapter.js ---
/**
 * Thin wrapper around `@colbymchenry/codegraph` — sole import site for the library.
 */
/** Process-env keys that turn CodeGraph telemetry off. */
export const CODEGRAPH_TELEMETRY_ENV_KEYS = Object.freeze(['CODEGRAPH_TELEMETRY', 'DO_NOT_TRACK']);

let telemetryConfigured = false;

/**
 * Sets CODEGRAPH_TELEMETRY=0 and DO_NOT_TRACK=1 on process.env (idempotent).
 * Call before the first dynamic import of `@colbymchenry/codegraph`.
 * Mutates process.env deliberately — CodeGraph only honors these keys when set
 * before load; this is not application config loading (see env-config.mdc).
 * @returns {void}
 */
export function configureCodegraphTelemetryOff() {
  /* eslint-disable no-restricted-properties -- CodeGraph reads these env keys at import time */
  process.env.CODEGRAPH_TELEMETRY = '0';
  process.env.DO_NOT_TRACK = '1';
  /* eslint-enable no-restricted-properties */
  telemetryConfigured = true;
}

/**
 * Returns whether configureCodegraphTelemetryOff has run in this process.
 * @returns {boolean}
 */
export function isCodegraphTelemetryConfigured() {
  return telemetryConfigured;
}

/**
 * Test helper — clears the configured flag (does not restore prior env values).
 * @returns {void}
 */
export function resetCodegraphTelemetryConfiguredFlag() {
  telemetryConfigured = false;
}
/** Bounded temporary retries for SQLite lock / transient IO inside one stage attempt. */
export const CODEGRAPH_MAX_SYNC_RETRY_ATTEMPTS = 3;

/** Wall-clock TTL for a CodeGraph read lease (browse / later chat tools). */
export const CODEGRAPH_READ_LEASE_TTL_MS = 10_000;

/** Library instance methods browse may wrap after a surface check. */
export const CODEGRAPH_QUERY_SURFACE_METHODS = Object.freeze([
  'searchNodes',
  'getNodesByNamePrefix',
  'getNodesByKind',
  'getRoutingManifest',
  'getStats',
  'getDetectedFrameworks',
  'buildContext',
]);

/**
 * Reports which query methods exist on a live graph instance.
 * @param {object | null | undefined} graph Library instance.
 * @returns {Readonly<Record<string, boolean>>}
 */
export function inspectQuerySurface(graph) {
  /** @type {Record<string, boolean>} */
  const surface = {};
  for (const name of CODEGRAPH_QUERY_SURFACE_METHODS) {
    surface[name] = typeof graph?.[name] === 'function';
  }
  return Object.freeze(surface);
}

/**
 * Loads the CodeGraph library after forcing telemetry off.
 * @returns {Promise<{
 *   CodeGraph: {
 *     init: (root: string, options?: object) => Promise<object>,
 *     open: (root: string, options?: object) => Promise<object>,
 *     isInitialized: (root: string) => boolean,
 *     recreate: (root: string) => Promise<object>,
 *   },
 *   getDatabasePath: (root: string) => string,
 * }>}
 */
async function defaultLoadLibrary() {
  configureCodegraphTelemetryOff();
  const mod = await import('@colbymchenry/codegraph');
  const CodeGraph = mod.default ?? mod.CodeGraph;
  if (!CodeGraph) {
    throw Object.assign(new Error('CodeGraph export missing from package.'), {
      code: 'CODEGRAPH_LIBRARY_UNAVAILABLE',
    });
  }
  return {
    CodeGraph,
    getDatabasePath: mod.getDatabasePath,
  };
}

/**
 * True when the npm package can be imported in this environment.
 * @returns {Promise<boolean>}
 */
export async function isCodegraphLoadable() {
  try {
    configureCodegraphTelemetryOff();
    await import('@colbymchenry/codegraph');
    return true;
  } catch {
    return false;
  }
}

/**
 * Maps a thrown library error to a stage-friendly failure descriptor.
 * @param {unknown} err Thrown value.
 * @returns {{ failureClass: 'temporary' | 'permanent', code: string, message: string }}
 */
export function mapCodegraphLibraryError(err) {
  const message = err instanceof Error ? err.message : String(err ?? 'CodeGraph failed');
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String(/** @type {{ code?: unknown }} */ (err).code)
      : '';

  if (
    code === 'SQLITE_BUSY' ||
    code === 'EBUSY' ||
    /database is locked/i.test(message) ||
    /SQLITE_BUSY/i.test(message) ||
    /EAGAIN/i.test(message)
  ) {
    return {
      failureClass: 'temporary',
      code: 'CODEGRAPH_SQLITE_BUSY',
      message: 'The code index is temporarily locked.',
    };
  }

  if (code === 'ENOENT' || code === 'ENOSPC' || code === 'EACCES') {
    return {
      failureClass: 'temporary',
      code: 'CODEGRAPH_IO_ERROR',
      message: 'The code index could not be written because of a temporary IO problem.',
    };
  }

  return {
    failureClass: 'temporary',
    code: 'CODEGRAPH_LIBRARY_ERROR',
    message: 'Code index update failed.',
  };
}

/**
 * Fingerprints the on-disk SQLite database for graphIdentity.graphHash.
 * @param {string} databasePath Absolute path to codegraph.db.
 * @returns {Promise<string | null>}
 */
async function fingerprintDatabase(databasePath) {
  try {
    const stats = await fs.stat(databasePath);
    return createHash('sha256')
      .update(`${stats.size}:${Math.trunc(stats.mtimeMs)}`)
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * Creates the CodeGraph adapter used by ingest S4 (and later read-side tools).
 * @param {{
 *   loadLibrary?: () => Promise<{
 *     CodeGraph: object,
 *     getDatabasePath?: (root: string) => string,
 *   }>,
 *   acquireWriter?: (scope: { orgId: string, projectId: string }) => Promise<() => void>,
 *   maxRetryAttempts?: number,
 * }} [config] Optional test seams.
 * @returns {{
 *   configureTelemetryOff: () => void,
 *   disableFilesystemWatch: (graph: { unwatch?: () => void, isWatching?: () => boolean }) => void,
 *   acquireWriter: (scope: { orgId: string, projectId: string }) => Promise<() => void>,
 *   releaseWriter: (release: () => void) => void,
 *   indexAll: (workspacePath: string, options: object) => Promise<object>,
 *   sync: (workspacePath: string, options: object) => Promise<object>,
 *   validate: (workspacePath: string, options: object) => Promise<object>,
 *   acquireReadLease: (input: object) => Promise<object>,
 *   inspectQuerySurface: typeof inspectQuerySurface,
 *   querySymbols: (graph: object, q: string, limit: number) => object[],
 *   queryApis: (graph: object, limit: number) => object[],
 *   queryWorkflows: (graph: object, limit: number) => object[],
 *   queryStats: (graph: object) => object | null,
 *   explore: (workspacePath: string, input: object) => Promise<unknown>,
 *   buildContext: (workspacePath: string, input: object) => Promise<unknown>,
 * }}
 */
export function createCodegraphAdapter(config = {}) {
  const loadLibrary = config.loadLibrary ?? defaultLoadLibrary;
  const acquireWriterFn = config.acquireWriter ?? acquireProjectWriter;
  const maxRetryAttempts = config.maxRetryAttempts ?? CODEGRAPH_MAX_SYNC_RETRY_ATTEMPTS;

  /** @type {null | { CodeGraph: object, getDatabasePath?: (root: string) => string }} */
  let library = null;

  /**
   * @returns {Promise<{ CodeGraph: object, getDatabasePath?: (root: string) => string }>}
   */
  async function ensureLibrary() {
    if (!library) {
      configureCodegraphTelemetryOff();
      library = await loadLibrary();
    }
    return library;
  }

  /**
   * Ensures the watcher stays off on a live graph instance.
   * @param {{ unwatch?: () => void, isWatching?: () => boolean }} graph Library instance.
   * @returns {void}
   */
  function disableFilesystemWatch(graph) {
    if (typeof graph?.unwatch === 'function') {
      graph.unwatch();
    }
    if (typeof graph?.isWatching === 'function' && graph.isWatching()) {
      throw Object.assign(new Error('CodeGraph filesystem watcher could not be disabled.'), {
        code: 'CODEGRAPH_WATCHER_ACTIVE',
      });
    }
  }

  /**
   * Opens or initializes a graph without enabling auto-index/sync/watch.
   * @param {string} workspacePath Absolute workspace.
   * @param {{ forceRecreate?: boolean }} [options] Open options.
   * @returns {Promise<object>}
   */
  async function openOrInitGraph(workspacePath, options = {}) {
    const { CodeGraph } = await ensureLibrary();
    configureCodegraphTelemetryOff();

    if (options.forceRecreate && typeof CodeGraph.recreate === 'function') {
      const graph = await CodeGraph.recreate(workspacePath);
      disableFilesystemWatch(graph);
      return graph;
    }

    const exists =
      typeof CodeGraph.isInitialized === 'function'
        ? CodeGraph.isInitialized(workspacePath)
        : await codegraphIndexExists(workspacePath);

    const graph = exists
      ? await CodeGraph.open(workspacePath, { sync: false, readOnly: false })
      : await CodeGraph.init(workspacePath, { index: false });
    disableFilesystemWatch(graph);
    return graph;
  }

  /**
   * Retries a writer operation on transient SQLite/IO failures.
   * @param {() => Promise<object>} operation Writer body.
   * @returns {Promise<object>}
   */
  async function withTransientRetries(operation) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (
          err &&
          typeof err === 'object' &&
          'failureClass' in err &&
          'code' in err &&
          (err.code === 'INGEST_ABORTED' || err.code === 'CODEGRAPH_WATCHER_ACTIVE')
        ) {
          throw err;
        }
        const mapped = mapCodegraphLibraryError(err);
        if (mapped.failureClass !== 'temporary' || attempt === maxRetryAttempts) {
          throw Object.assign(new Error(mapped.message), {
            failureClass: mapped.failureClass,
            code: mapped.code,
            cause: err,
          });
        }
      }
    }
    throw lastError;
  }

  return {
    configureTelemetryOff: configureCodegraphTelemetryOff,
    disableFilesystemWatch,

    /**
     * @param {{ orgId: string, projectId: string }} scope Tenant project.
     * @returns {Promise<() => void>}
     */
    async acquireWriter(scope) {
      return acquireWriterFn(scope);
    },

    /**
     * @param {() => void} release Release from acquireWriter.
     * @returns {void}
     */
    releaseWriter(release) {
      if (typeof release === 'function') {
        release();
      }
    },

    /**
     * Full index of the materialized workspace.
     * @param {string} workspacePath Absolute workspace.
     * @param {{
     *   excludedPaths?: string[],
     *   signal?: AbortSignal,
     * }} [options] Index options.
     * @returns {Promise<{
     *   mode: 'indexAll',
     *   success: boolean,
     *   indexedFileCount: number,
     *   skippedFileCount: number,
     *   filesErrored: number,
     *   graphPath: string,
     *   graphHash: string | null,
     *   raw: object,
     * }>}
     */
    async indexAll(workspacePath, options = {}) {
      await writeCodegraphExcludeConfig(workspacePath, options.excludedPaths ?? []);
      return withTransientRetries(async () => {
        // Fresh full index: recreate when an index already exists so we do not
        // inherit a truncated mid-failure graph from a prior attempt.
        const already = await codegraphIndexExists(workspacePath);
        const graph = await openOrInitGraph(workspacePath, { forceRecreate: already });
        try {
          if (options.signal?.aborted) {
            throw Object.assign(new Error('CodeGraph index aborted.'), {
              code: 'INGEST_ABORTED',
              failureClass: 'temporary',
            });
          }
          const raw = await graph.indexAll({ signal: options.signal });
          disableFilesystemWatch(graph);
          const graphPath = resolveCodegraphDir(workspacePath);
          const { getDatabasePath } = await ensureLibrary();
          const dbPath =
            typeof getDatabasePath === 'function'
              ? getDatabasePath(workspacePath)
              : path.join(graphPath, 'codegraph.db');
          const graphHash = await fingerprintDatabase(dbPath);
          return {
            mode: /** @type {'indexAll'} */ ('indexAll'),
            success: raw?.success !== false,
            indexedFileCount: Number(raw?.filesIndexed ?? 0),
            skippedFileCount: Number(raw?.filesSkipped ?? 0),
            filesErrored: Number(raw?.filesErrored ?? 0),
            graphPath,
            graphHash,
            raw,
            graph,
          };
        } catch (err) {
          try {
            graph.close?.();
          } catch {
            // ignore close errors
          }
          throw err;
        }
      });
    },

    /**
     * Incremental sync when `.codegraph` already exists.
     * @param {string} workspacePath Absolute workspace.
     * @param {{
     *   excludedPaths?: string[],
     *   changedPaths?: string[],
     *   signal?: AbortSignal,
     * }} [options] Sync options.
     * @returns {Promise<{
     *   mode: 'sync',
     *   success: boolean,
     *   indexedFileCount: number,
     *   skippedFileCount: number,
     *   filesErrored: number,
     *   graphPath: string,
     *   graphHash: string | null,
     *   raw: object,
     * }>}
     */
    async sync(workspacePath, options = {}) {
      await writeCodegraphExcludeConfig(workspacePath, options.excludedPaths ?? []);
      return withTransientRetries(async () => {
        const graph = await openOrInitGraph(workspacePath);
        try {
          if (options.signal?.aborted) {
            throw Object.assign(new Error('CodeGraph sync aborted.'), {
              code: 'INGEST_ABORTED',
              failureClass: 'temporary',
            });
          }
          /** @type {{ signal?: AbortSignal, paths?: string[] }} */
          const syncOptions = { signal: options.signal };
          if (Array.isArray(options.changedPaths) && options.changedPaths.length > 0) {
            syncOptions.paths = options.changedPaths;
          }
          const raw = await graph.sync(syncOptions);
          disableFilesystemWatch(graph);
          const graphPath = resolveCodegraphDir(workspacePath);
          const { getDatabasePath } = await ensureLibrary();
          const dbPath =
            typeof getDatabasePath === 'function'
              ? getDatabasePath(workspacePath)
              : path.join(graphPath, 'codegraph.db');
          const graphHash = await fingerprintDatabase(dbPath);
          const indexedFileCount =
            Number(raw?.filesAdded ?? 0) + Number(raw?.filesModified ?? 0);
          return {
            mode: /** @type {'sync'} */ ('sync'),
            success: true,
            indexedFileCount,
            skippedFileCount: 0,
            filesErrored: 0,
            graphPath,
            graphHash,
            raw,
            graph,
          };
        } catch (err) {
          try {
            graph.close?.();
          } catch {
            // ignore close errors
          }
          throw err;
        }
      });
    },

    /**
     * Runs post-index validation probes.
     * @param {string} workspacePath Absolute workspace.
     * @param {{
     *   graph?: object,
     *   sourceVersionId: string,
     *   mode: 'indexAll' | 'sync',
     *   indexedFileCount: number,
     *   skippedFileCount: number,
     *   expectedIndexedFileCount: number,
     *   expectedExcludedCount: number,
     *   graphPath: string,
     *   graphHash?: string | null,
     * }} options Validation context.
     * @returns {Promise<object>}
     */
    async validate(workspacePath, options) {
      let graph = options.graph;
      let owned = false;
      if (!graph) {
        graph = await openOrInitGraph(workspacePath);
        owned = true;
      }
      try {
        disableFilesystemWatch(graph);
        return await validateCodegraphIndex({
          graph,
          expectedIndexedFileCount: options.expectedIndexedFileCount,
          expectedExcludedCount: options.expectedExcludedCount,
          graphPath: options.graphPath ?? resolveCodegraphDir(workspacePath),
          sourceVersionId: options.sourceVersionId,
          mode: options.mode,
          indexedFileCount: options.indexedFileCount,
          skippedFileCount: options.skippedFileCount,
          graphHash: options.graphHash ?? null,
        });
      } finally {
        if (owned) {
          try {
            graph.close?.();
          } catch {
            // ignore
          }
        }
      }
    },

    inspectQuerySurface,

    /**
     * Opens a read-only graph when no writer holds the project.
     * @param {{
     *   orgId: string,
     *   projectId: string,
     *   workspacePath: string,
     *   ttlMs?: number,
     * }} input Lease scope.
     * @returns {Promise<
     *   | { ok: true, lease: { graph: object, expired: boolean, release: () => void } }
     *   | { ok: false, reason: 'writer' | 'missing' }
     * >}
     */
    async acquireReadLease(input) {
      const hasMongoWriter =
        config.hasMongoWriterLock ?? hasActiveProjectWriterLock;
      const writerHeld =
        (config.isInProcessWriterHeld ?? isWriterHeld)({
          orgId: input.orgId,
          projectId: input.projectId,
        }) || (await hasMongoWriter({ orgId: input.orgId, projectId: input.projectId }));
      if (writerHeld) {
        return { ok: false, reason: 'writer' };
      }

      const { CodeGraph } = await ensureLibrary();
      const exists =
        typeof CodeGraph.isInitialized === 'function'
          ? CodeGraph.isInitialized(input.workspacePath)
          : await codegraphIndexExists(input.workspacePath);
      if (!exists) {
        return { ok: false, reason: 'missing' };
      }

      const openOptions = { sync: false, readOnly: true };
      const graph = await CodeGraph.open(input.workspacePath, openOptions);
      disableFilesystemWatch(graph);

      const ttlMs = input.ttlMs ?? CODEGRAPH_READ_LEASE_TTL_MS;
      let released = false;
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        releaseLease();
      }, ttlMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      /**
       * Releases the graph handle once.
       */
      function releaseLease() {
        if (released) {
          return;
        }
        released = true;
        clearTimeout(timer);
        try {
          graph.close?.();
        } catch {
          // ignore close errors
        }
      }

      return {
        ok: true,
        lease: {
          graph,
          get expired() {
            return expired;
          },
          release: releaseLease,
        },
      };
    },

    /**
     * Bounded symbol lookup using real library methods only.
     * @param {object} graph Open graph.
     * @param {string} query Prefix or search text.
     * @param {number} limit Max rows.
     * @returns {object[]}
     */
    querySymbols(graph, query, limit) {
      const surface = inspectQuerySurface(graph);
      if (surface.getNodesByNamePrefix) {
        return graph.getNodesByNamePrefix(query, limit) ?? [];
      }
      if (surface.searchNodes) {
        return graph.searchNodes(query, { limit }) ?? [];
      }
      return [];
    },

    /**
     * Route / API entries when the library exposes them.
     * @param {object} graph Open graph.
     * @param {number} limit Max rows.
     * @returns {object[]}
     */
    queryApis(graph, limit) {
      const surface = inspectQuerySurface(graph);
      if (surface.getRoutingManifest) {
        const manifest = graph.getRoutingManifest(limit);
        return Array.isArray(manifest?.entries) ? manifest.entries : [];
      }
      if (surface.getNodesByKind) {
        return (graph.getNodesByKind('route') ?? []).slice(0, limit);
      }
      return [];
    },

    /**
     * Workflow-oriented nodes. The library has no first-class workflow API.
     * @param {object} graph Open graph.
     * @param {number} _limit Unused; kept for call-site symmetry.
     * @returns {object[]}
     */
    queryWorkflows(graph, _limit) {
      void _limit;
      void graph;
      return [];
    },

    /**
     * Graph stats when `getStats` exists.
     * @param {object} graph Open graph.
     * @returns {object | null}
     */
    queryStats(graph) {
      if (inspectQuerySurface(graph).getStats) {
        return graph.getStats() ?? null;
      }
      return null;
    },

    /**
     * Read-side explore — wraps the library method when present.
     * @param {string} _workspacePath Unused until a caller supplies a lease.
     * @returns {Promise<never>}
     */
    async explore(_workspacePath) {
      throw Object.assign(new Error('CodeGraph explore is not implemented yet.'), {
        code: 'NOT_IMPLEMENTED',
        failureClass: 'permanent',
      });
    },

    /**
     * Read-side buildContext — wraps the library method when present.
     * @param {string} _workspacePath Unused until a caller supplies a lease.
     * @returns {Promise<never>}
     */
    async buildContext(_workspacePath) {
      throw Object.assign(new Error('CodeGraph buildContext is not implemented yet.'), {
        code: 'NOT_IMPLEMENTED',
        failureClass: 'permanent',
      });
    },
  };
}
