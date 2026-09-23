/**
 * Path + sha256 source-version diff used by ingest (Phase 29).
 */
import { listSourceFilePathHashesPage } from './sources.repository.js';

/** Paths loaded per query batch when comparing two versions. */
export const SOURCE_DIFF_BATCH_SIZE = 500;

/**
 * Classifies two path+hash maps into added/removed/changed/unchanged sets.
 * @param {Map<string, string>} incomingByPath Incoming version path → sha256.
 * @param {Map<string, string> | null} publishedByPath Last published path → sha256, or null.
 * @returns {{
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }}
 */
export function classifySourceDiff(incomingByPath, publishedByPath) {
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  if (!publishedByPath || publishedByPath.size === 0) {
    const allAdded = [...incomingByPath.keys()].sort();
    return {
      added: allAdded,
      removed: [],
      changed: [],
      unchanged: [],
      counts: {
        added: allAdded.length,
        removed: 0,
        changed: 0,
        unchanged: 0,
      },
    };
  }

  for (const [filePath, sha256] of incomingByPath) {
    const priorHash = publishedByPath.get(filePath);
    if (priorHash === undefined) {
      added.push(filePath);
    } else if (priorHash === sha256) {
      unchanged.push(filePath);
    } else {
      changed.push(filePath);
    }
  }

  for (const filePath of publishedByPath.keys()) {
    if (!incomingByPath.has(filePath)) {
      removed.push(filePath);
    }
  }

  added.sort();
  removed.sort();
  changed.sort();
  unchanged.sort();

  return {
    added,
    removed,
    changed,
    unchanged,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

/**
 * Loads all active path+sha256 pairs for a source version in batches.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   batchSize?: number,
 * }} input Scope.
 * @returns {Promise<Map<string, string>>}
 */
export async function loadPathHashesForVersion(input) {
  const batchSize = input.batchSize ?? SOURCE_DIFF_BATCH_SIZE;
  /** @type {Map<string, string>} */
  const byPath = new Map();
  let afterPath = null;
  for (;;) {
    const page = await listSourceFilePathHashesPage({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      afterPath,
      limit: batchSize,
    });
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      byPath.set(row.path, row.sha256);
    }
    if (page.length < batchSize) {
      break;
    }
    afterPath = page[page.length - 1].path;
  }
  return byPath;
}

/**
 * Compares an incoming source version to the last published one.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   incomingSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   publishedSourceVersionId?: string | import('mongoose').Types.ObjectId | null,
 * }} input Versions to compare.
 * @returns {Promise<{
 *   baseSourceVersionId: string | null,
 *   incomingSourceVersionId: string,
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }>}
 */
export async function computeSourceDiff(input) {
  const incomingByPath = await loadPathHashesForVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.incomingSourceVersionId,
  });
  const publishedId = input.publishedSourceVersionId
    ? String(input.publishedSourceVersionId)
    : null;
  const publishedByPath =
    publishedId && publishedId !== String(input.incomingSourceVersionId)
      ? await loadPathHashesForVersion({
          orgId: input.orgId,
          projectId: input.projectId,
          sourceVersionId: publishedId,
        })
      : null;
  const classified = classifySourceDiff(incomingByPath, publishedByPath);
  return {
    baseSourceVersionId: publishedByPath ? publishedId : null,
    incomingSourceVersionId: String(input.incomingSourceVersionId),
    ...classified,
  };
}

/**
 * Derives ingest carry path sets from a computed diff.
 * @param {{
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   baseSourceVersionId?: string | null,
 * }} diff Diff DTO.
 * @returns {{
 *   skipPaths: Set<string>,
 *   changedPaths: string[],
 *   removedPaths: string[],
 *   baseSourceVersionId: string | null,
 * }}
 */
export function carryFromSourceDiff(diff) {
  return {
    skipPaths: new Set(diff.unchanged),
    changedPaths: [...diff.changed, ...diff.added],
    removedPaths: [...diff.removed],
    baseSourceVersionId: diff.baseSourceVersionId ?? null,
  };
}
