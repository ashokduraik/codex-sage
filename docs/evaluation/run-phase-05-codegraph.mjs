/**
 * Bounded CodeGraph measurement for Phase 05 (D4: this product tree only).
 * Usage: node docs/evaluation/run-phase-05-codegraph.mjs
 */
import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodegraphAdapter } from '../../backend/src/modules/knowledge/codegraph.js';
import { ACCEPTED_CODE_EXTENSIONS, kindForSourcePath } from '../../backend/src/modules/knowledge/uploads.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(repoRoot, 'backend/tests/fixtures/codegraph');
const backendSrc = path.join(repoRoot, 'backend/src');

/**
 * @param {string} dir Directory.
 * @returns {Promise<number>}
 */
async function directoryBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      total += (await stat(full)).size;
    }
  }
  return total;
}

/**
 * @param {string} workspace Absolute workspace.
 * @returns {Promise<object>}
 */
async function measureIndex(workspace) {
  const adapter = createCodegraphAdapter();
  const samples = [];
  const timer = setInterval(() => {
    samples.push(process.memoryUsage().rss);
  }, 50);
  const started = process.hrtime.bigint();
  const baseline = process.memoryUsage().rss;
  const result = await adapter.indexAll(workspace);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  clearInterval(timer);
  samples.push(process.memoryUsage().rss);
  const dbPath = path.join(workspace, '.codegraph', 'codegraph.db');
  let sqliteBytes = 0;
  try {
    sqliteBytes = (await stat(dbPath)).size;
  } catch {
    sqliteBytes = await directoryBytes(path.join(workspace, '.codegraph'));
  }
  try {
    result.graph?.close?.();
  } catch {
    // ignore
  }
  return {
    elapsedMs: Math.round(elapsedMs),
    sqliteBytes,
    peakRssBytes: Math.max(baseline, ...samples),
    baselineRssBytes: baseline,
    indexedFileCount: result.indexedFileCount,
    skippedFileCount: result.skippedFileCount,
    filesErrored: result.filesErrored,
    success: result.success,
  };
}

/**
 * @param {string} source Source tree.
 * @param {string} dest Destination.
 * @returns {Promise<void>}
 */
async function copyTree(source, dest) {
  await cp(source, dest, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.includes(`${path.sep}.codegraph${path.sep}`),
  });
}

const work = await mkdtemp(path.join(os.tmpdir(), 'phase05-'));

try {
  const fixtureWs = path.join(work, 'fixture');
  const backendWs = path.join(work, 'backend-src');
  await copyTree(fixtureRoot, fixtureWs);
  await copyTree(backendSrc, backendWs);

  const fixture = await measureIndex(fixtureWs);
  const backend = await measureIndex(backendWs);
  const cjsKind = kindForSourcePath('lib/run.cjs');
  const report = {
    recordedAt: new Date().toISOString(),
    acceptedCodeExtensions: [...ACCEPTED_CODE_EXTENSIONS],
    fixtureCjsKind: cjsKind,
    fixture,
    backendSrc: backend,
  };
  const outPath = path.join(repoRoot, 'docs/evaluation/phase-05-codegraph.raw.json');
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
