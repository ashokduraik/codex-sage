/**
 * Thin wrapper around `@colbymchenry/codegraph` — sole import site for the library.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  codegraphIndexExists,
  resolveCodegraphDir,
  writeCodegraphExcludeConfig,
} from './codegraph.paths.js';
import { configureCodegraphTelemetryOff } from './codegraph.telemetry.js';
import { validateCodegraphIndex } from './codegraph.validate.js';
import { acquireWriter as acquireProjectWriter } from './codegraph.writerLock.js';

/** Bounded temporary retries for SQLite lock / transient IO inside one stage attempt. */
export const CODEGRAPH_MAX_SYNC_RETRY_ATTEMPTS = 3;

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
 *   explore: () => Promise<never>,
 *   buildContext: () => Promise<never>,
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

    /**
     * Read-side stub until phase 46.
     * @returns {Promise<never>}
     */
    async explore() {
      throw Object.assign(new Error('CodeGraph explore is not implemented yet.'), {
        code: 'NOT_IMPLEMENTED',
        failureClass: 'permanent',
      });
    },

    /**
     * Read-side stub until phase 46.
     * @returns {Promise<never>}
     */
    async buildContext() {
      throw Object.assign(new Error('CodeGraph buildContext is not implemented yet.'), {
        code: 'NOT_IMPLEMENTED',
        failureClass: 'permanent',
      });
    },
  };
}
