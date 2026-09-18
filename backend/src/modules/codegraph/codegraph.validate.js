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
