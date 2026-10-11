/**
 * knowledge/documents.js — merged resource file.
 */
import mongoose from 'mongoose';
import { SourceFile } from '../../models/sourceFile.model.js';
import { DocumentSection } from '../../models/documentSection.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';

/** Default page size for document-path listings used by agent tools. */
export const LIST_DOCUMENT_FILES_PAGE_SIZE = 20;

/** Hard cap so a tool cannot request an unbounded SourceFile page. */
export const LIST_DOCUMENT_FILES_MAX_LIMIT = 100;

// --- from documents/documentSection.parse.js ---
/**
 * Split Markdown/MDX/plain-text into bounded DocumentSection DTOs.
 *
 * Uses an ATX-heading line scanner rather than unified/remark: those packages'
 * latest publishes were outside the project's 12-month maintenance gate
 * (dependency-versions.mdc). Heading grain matches the Phase 26 plan.
 */

/** Maximum searchable characters stored per section. */
export const DOCUMENT_SECTION_MAX_CHARS = 8000;

/** Line window size for plain-text (.txt) files. */
export const DOCUMENT_TXT_SECTION_LINE_WINDOW = 80;

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * @typedef {{
 *   heading: string | null,
 *   startLine: number,
 *   endLine: number,
 *   text: string,
 *   sectionIndex: number,
 * }} DocumentSectionDto
 */

/**
 * Returns true when the path is a documentation extension supported for FTS.
 * @param {string} filePath Repo-relative path.
 * @returns {boolean}
 */
export function isDocumentPath(filePath) {
  const lower = String(filePath ?? '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt');
}

/**
 * Caps section text to DOCUMENT_SECTION_MAX_CHARS.
 * @param {string} text Raw section text.
 * @returns {string}
 */
export function capSectionText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= DOCUMENT_SECTION_MAX_CHARS) {
    return value;
  }
  return value.slice(0, DOCUMENT_SECTION_MAX_CHARS);
}

/**
 * Parses file contents into ordered section DTOs.
 * @param {{ path: string, content: string }} input Path + UTF-8 content.
 * @returns {DocumentSectionDto[]}
 */
export function parseDocumentSections(input) {
  const filePath = String(input.path ?? '');
  const content = typeof input.content === 'string' ? input.content : '';
  if (!isDocumentPath(filePath)) {
    return [];
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.txt')) {
    return splitPlainTextWindows(content);
  }
  return splitMarkdownByHeadings(content);

  /**
   * Splits Markdown/MDX on ATX headings; no heading → one section for the file.
   * @param {string} content File text.
   * @returns {DocumentSectionDto[]}
   */
  function splitMarkdownByHeadings(content) {
    const lines = content.length === 0 ? [] : content.split(/\r?\n/);
    if (lines.length === 0) {
      return [
        {
          heading: null,
          startLine: 1,
          endLine: 1,
          text: '',
          sectionIndex: 0,
        },
      ];
    }

    /** @type {Array<{ heading: string | null, startLine: number, lineStartIndex: number }>} */
    const markers = [];
    for (let i = 0; i < lines.length; i += 1) {
      const match = ATX_HEADING.exec(lines[i]);
      if (match) {
        markers.push({
          heading: match[2].trim() || null,
          startLine: i + 1,
          lineStartIndex: i,
        });
      }
    }

    if (markers.length === 0) {
      return [
        {
          heading: null,
          startLine: 1,
          endLine: lines.length,
          text: capSectionText(lines.join('\n')),
          sectionIndex: 0,
        },
      ];
    }

    /** @type {DocumentSectionDto[]} */
    const sections = [];

    // Preface before the first heading (only when non-empty).
    if (markers[0].lineStartIndex > 0) {
      const prefaceLines = lines.slice(0, markers[0].lineStartIndex);
      const prefaceText = prefaceLines.join('\n').trim();
      if (prefaceText.length > 0) {
        sections.push({
          heading: null,
          startLine: 1,
          endLine: markers[0].startLine - 1,
          text: capSectionText(prefaceLines.join('\n')),
          sectionIndex: 0,
        });
      }
    }

    for (let m = 0; m < markers.length; m += 1) {
      const start = markers[m].lineStartIndex;
      const endExclusive = m + 1 < markers.length ? markers[m + 1].lineStartIndex : lines.length;
      const slice = lines.slice(start, endExclusive);
      sections.push({
        heading: markers[m].heading,
        startLine: markers[m].startLine,
        endLine: endExclusive,
        text: capSectionText(slice.join('\n')),
        sectionIndex: sections.length,
      });
    }

    return sections;
  }

  /**
   * Splits plain text into fixed line windows.
   * @param {string} content File text.
   * @returns {DocumentSectionDto[]}
   */
  function splitPlainTextWindows(content) {
    const lines = content.length === 0 ? [''] : content.split(/\r?\n/);
    /** @type {DocumentSectionDto[]} */
    const sections = [];
    for (let start = 0; start < lines.length; start += DOCUMENT_TXT_SECTION_LINE_WINDOW) {
      const endExclusive = Math.min(start + DOCUMENT_TXT_SECTION_LINE_WINDOW, lines.length);
      const slice = lines.slice(start, endExclusive);
      sections.push({
        heading: null,
        startLine: start + 1,
        endLine: endExclusive,
        text: capSectionText(slice.join('\n')),
        sectionIndex: sections.length,
      });
    }
    return sections;
  }
}

// --- from documents/documentSection.repository.js ---
/**
 * Tenant-scoped DocumentSection persistence (soft-delete by version/path).
 */
/**
 * Soft-deletes all active sections for a source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + version scope.
 * @returns {Promise<number>} Number of rows soft-deleted.
 */
export async function softDeleteSectionsForVersion(scope) {
  assertOrgId(scope.orgId);
  const result = await DocumentSection.updateMany(
    {
      orgId: scope.orgId,
      projectId: scope.projectId,
      sourceVersionId: scope.sourceVersionId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedAt: new Date(),
      },
    },
  ).exec();
  return result.modifiedCount;
}

/**
 * Soft-deletes active sections for one path within a version (idempotent replace).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 * }} input Scope + path.
 * @returns {Promise<number>} Number of rows soft-deleted.
 */
export async function softDeleteSectionsForPath(input) {
  assertOrgId(input.orgId);
  const result = await DocumentSection.updateMany(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      path: input.path,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedAt: new Date(),
      },
    },
  ).exec();
  return result.modifiedCount;
}

/**
 * Inserts section DTOs as active DocumentSection rows.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 *   sections: Array<{
 *     heading: string | null,
 *     startLine: number,
 *     endLine: number,
 *     text: string,
 *     sectionIndex: number,
 *   }>,
 * }} input Rows to insert.
 * @returns {Promise<number>} Number of inserted documents.
 */
export async function insertDocumentSections(input) {
  assertOrgId(input.orgId);
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    return 0;
  }
  const now = new Date();
  const docs = input.sections.map((section) => ({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    path: input.path,
    heading: section.heading,
    startLine: section.startLine,
    endLine: section.endLine,
    text: section.text,
    sectionIndex: section.sectionIndex,
    status: ROW_STATUS_ACTIVE,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }));
  const inserted = await DocumentSection.insertMany(docs, { ordered: true });
  return inserted.length;
}

/**
 * Lists active sections for a path (tests / diagnostics).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   path: string,
 * }} input Scope + path.
 * @returns {Promise<object[]>}
 */
export async function listSectionsForPath(input) {
  assertOrgId(input.orgId);
  return DocumentSection.find({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    path: input.path,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ sectionIndex: 1 })
    .lean()
    .exec();
}

/**
 * Lists active sections for a source version (path + section order).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Version scope.
 * @param {{ limit?: number }} [options] Cap (defaults to 50).
 * @returns {Promise<object[]>}
 */
export async function listSectionsForVersion(scope, options = {}) {
  assertOrgId(scope.orgId);
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
  return DocumentSection.find({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ path: 1, sectionIndex: 1 })
    .limit(limit)
    .lean()
    .exec();
}

/**
 * Full-text search of active sections for a source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Version scope.
 * @param {{ q: string, limit: number, pathPrefix?: string }} options Query and cap.
 * @returns {Promise<object[]>}
 */
export async function searchDocumentSections(scope, options) {
  assertOrgId(scope.orgId);
  const query = typeof options.q === 'string' ? options.q.trim() : '';
  if (!query) {
    return [];
  }
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 15;
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
    $text: { $search: query },
  };
  const pathPrefix = typeof options.pathPrefix === 'string' ? options.pathPrefix.trim() : '';
  if (pathPrefix) {
    filter.path = { $regex: `^${escapeRegex(pathPrefix)}` };
  }
  return DocumentSection.find(filter, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean()
    .exec();

  /**
   * Escapes user text so it is a literal prefix in a Mongo regex.
   * @param {string} value Raw prefix.
   * @returns {string}
   */
  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Lists active document files for a source version (metadata only).
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   afterPath?: string,
 *   limit?: number,
 * }} input Version scope and keyset.
 * @returns {Promise<object[]>}
 */
export async function listDocumentFilesForVersion(input) {
  assertOrgId(input.orgId);
  const rawLimit = Number(input.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), LIST_DOCUMENT_FILES_MAX_LIMIT) : LIST_DOCUMENT_FILES_PAGE_SIZE;
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
    kind: 'doc',
  };
  const afterPath = typeof input.afterPath === 'string' ? input.afterPath : '';
  if (afterPath) {
    filter.path = { $gt: afterPath };
  }
  return SourceFile.find(filter)
    .sort({ path: 1 })
    .limit(limit)
    .select({ path: 1, kind: 1, excludedFromGraph: 1, exclusionReason: 1, byteLength: 1 })
    .lean()
    .exec();
}

/**
 * Loads one active section by id within a version scope.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   sectionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope + section id.
 * @returns {Promise<object | null>}
 */
export async function findDocumentSectionById(scope) {
  assertOrgId(scope.orgId);
  if (!scope.sectionId || !mongoose.isValidObjectId(scope.sectionId)) {
    return null;
  }
  return DocumentSection.findOne({
    _id: scope.sectionId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Counts active sections for a source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<number>}
 */
export async function countSectionsForVersion(scope) {
  assertOrgId(scope.orgId);
  return DocumentSection.countDocuments({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  }).exec();
}

/**
 * Copies active sections for selected paths from one source version onto another.
 * Existing target paths are left untouched so retries stay idempotent.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   fromSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   toSourceVersionId: string | import('mongoose').Types.ObjectId,
 *   paths: string[],
 * }} input Copy scope.
 * @returns {Promise<number>} Number of inserted section rows.
 */
export async function copySectionsForPaths(input) {
  assertOrgId(input.orgId);
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    return 0;
  }

  const alreadyOnTarget = await DocumentSection.distinct('path', {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.toSourceVersionId,
    path: { $in: input.paths },
    status: ROW_STATUS_ACTIVE,
  }).exec();
  const already = new Set(alreadyOnTarget);
  const remainingPaths = input.paths.filter((filePath) => !already.has(filePath));
  if (remainingPaths.length === 0) {
    return 0;
  }

  const sourceRows = await DocumentSection.find({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: input.fromSourceVersionId,
    path: { $in: remainingPaths },
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
  if (sourceRows.length === 0) {
    return 0;
  }

  const now = new Date();
  const docs = sourceRows.map((row) => ({
    orgId: row.orgId,
    projectId: row.projectId,
    sourceVersionId: input.toSourceVersionId,
    path: row.path,
    heading: row.heading,
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
    sectionIndex: row.sectionIndex,
    status: ROW_STATUS_ACTIVE,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  }));
  const inserted = await DocumentSection.insertMany(docs, { ordered: true });
  return inserted.length;
}

export { DocumentSection } from '../../models/documentSection.model.js';
export const DOCUMENT_MODELS = Object.freeze([DocumentSection]);
