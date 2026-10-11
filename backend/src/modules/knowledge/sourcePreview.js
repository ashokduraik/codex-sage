/**
 * knowledge/sourcePreview.js — merged resource file.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { findProjectById } from '../masters/index.js';
import { findKnowledgeVersionById } from './knowledge.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { isUnsafeArchivePath, normalizeArchivePath } from './uploads.js';
import { readSourceGridFsBytes, findSourceFileByPath } from './sources.js';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';

// --- from sources/sourcePreview.service.js ---
/**
 * Bounded file metadata and line-slice reads for the current source version.
 */
/** Max UTF-8 bytes returned in a slice (interim until evaluation). */
export const SOURCE_PREVIEW_MAX_BYTES = 65_536;

/** Secondary line cap on a slice (interim until evaluation). */
export const SOURCE_PREVIEW_MAX_LINES = 400;

/** Reject absurd preview paths. */
export const SOURCE_PATH_MAX_LENGTH = 1024;

/** Extensions treated as non-text for preview. */
export const SOURCE_PREVIEW_BINARY_EXTENSIONS = Object.freeze([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
]);

// --- from sources/sourcePreview.routes.js ---
/**
 * Source file metadata and slice HTTP routes.
 */
const metadataQuerySchema = z.object({
  path: z.string().min(1),
});
const sliceQuerySchema = metadataQuerySchema.extend({
  startLine: z.coerce.number().int(),
  endLine: z.coerce.number().int(),
});

/**
 * Builds the configured preview byte/line caps (optional overrides for pure helper tests).
 * @param {{ maxBytes?: number, maxLines?: number }} [overrides] Cap overrides.
 * @returns {{ maxBytes: number, maxLines: number }}
 */
export function createPreviewCaps(overrides = {}) {
  return {
    maxBytes: overrides.maxBytes ?? SOURCE_PREVIEW_MAX_BYTES,
    maxLines: overrides.maxLines ?? SOURCE_PREVIEW_MAX_LINES,
  };
}

/**
 * Normalizes a project-relative preview path or throws VALIDATION_ERROR.
 * @param {unknown} rawPath Query path.
 * @returns {string}
 * @throws {ApiError}
 */
export function normalizePreviewPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.includes('\0')) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'path', message: 'path must be a project-relative file path' }],
    });
  }
  const normalized = normalizeArchivePath(rawPath);
  if (!normalized || normalized.length > SOURCE_PATH_MAX_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'path', message: 'path is missing or too long' }],
    });
  }
  if (isUnsafeArchivePath(normalized)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'path', message: 'path must be project-relative and must not escape' }],
    });
  }
  return normalized;
}

/**
 * Guess a content type from the file extension.
 * @param {string} filePath Relative path.
 * @returns {string}
 */
export function contentTypeForPath(filePath) {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return 'text/javascript';
  }
  if (ext === 'json') {
    return 'application/json';
  }
  if (ext === 'md' || ext === 'mdx') {
    return 'text/markdown';
  }
  if (ext === 'css') {
    return 'text/css';
  }
  if (ext === 'html' || ext === 'htm') {
    return 'text/html';
  }
  if (SOURCE_PREVIEW_BINARY_EXTENSIONS.includes(ext)) {
    return 'application/octet-stream';
  }
  return 'text/plain';
}

/**
 * True when the path or bytes should not be sliced as text.
 * @param {string} filePath Relative path.
 * @param {Buffer} bytes File bytes.
 * @returns {boolean}
 */
export function isBinaryPreview(filePath, bytes) {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase() : '';
  if (SOURCE_PREVIEW_BINARY_EXTENSIONS.includes(ext)) {
    return true;
  }
  return bytes.includes(0);
}

/**
 * Counts newlines in a buffer (1 line when empty).
 * @param {Buffer} bytes File bytes.
 * @returns {number}
 */
export function countTextLines(bytes) {
  if (bytes.length === 0) {
    return 0;
  }
  let lines = 1;
  for (const byte of bytes) {
    if (byte === 10) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * Truncates a UTF-8 buffer without splitting a code point.
 * @param {Buffer} buffer Source bytes.
 * @param {number} maxBytes Cap.
 * @returns {{ text: string, truncated: boolean }}
 */
export function sliceUtf8(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Builds graph-coverage labels from a SourceFile row.
 * @param {object} file SourceFile lean row.
 * @returns {{ excludedFromGraph: boolean, graphCoverage: { includedInGraph: boolean, reason: string | null } }}
 */
export function graphCoverageFromFile(file) {
  const excluded = file.excludedFromGraph === true;
  return {
    excludedFromGraph: excluded,
    graphCoverage: {
      includedInGraph: !excluded,
      reason: excluded ? (file.exclusionReason ?? 'excluded') : null,
    },
  };
}

/**
 * Loads metadata for a current-version file.
 * @param {{ orgId: string, projectId: string, path: unknown }} input Request.
 * @returns {Promise<object>}
 */
export async function loadSourceFileMetadata(input) {
  const path = normalizePreviewPath(input.path);
  const scope = await loadCurrentSourceScope(input.orgId, input.projectId);
  const file = await findSourceFileByPath({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: scope.sourceVersionId,
    path,
  });
  if (!file) {
    throw ApiError.fromCode('SOURCE_NOT_FOUND');
  }
  const bytes = await readSourceGridFsBytes(file.gridFsId);
  const binary = isBinaryPreview(path, bytes);
  const coverage = graphCoverageFromFile(file);
  return {
    path,
    sourceVersionId: scope.sourceVersionId,
    knowledgeVersionId: scope.knowledgeVersionId,
    sizeBytes: Number(file.byteLength) || bytes.length,
    sha256: file.sha256,
    contentType: contentTypeForPath(path),
    ...coverage,
    lineCount: binary ? null : countTextLines(bytes),
    previewAvailable: !binary,
  };
}

/**
 * Loads a bounded line slice of a current-version file.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   path: unknown,
 *   startLine: unknown,
 *   endLine: unknown,
 * }} input Request.
 * @returns {Promise<object>}
 */
export async function loadSourceFileSlice(input) {
  const caps = createPreviewCaps();
  const path = normalizePreviewPath(input.path);
  const startLine = Number(input.startLine);
  const endLine = Number(input.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'startLine', message: 'startLine and endLine must be integers with endLine >= startLine >= 1' }],
    });
  }

  const scope = await loadCurrentSourceScope(input.orgId, input.projectId);
  const file = await findSourceFileByPath({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId: scope.sourceVersionId,
    path,
  });
  if (!file) {
    throw ApiError.fromCode('SOURCE_NOT_FOUND');
  }
  const bytes = await readSourceGridFsBytes(file.gridFsId);
  if (isBinaryPreview(path, bytes)) {
    throw ApiError.fromCode('UNSUPPORTED_MEDIA_TYPE');
  }
  const lines = bytes.toString('utf8').split(/\r?\n/);
  if (startLine > lines.length) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'startLine', message: 'startLine is past the end of the file' }],
    });
  }
  const requested = lines.slice(startLine - 1, endLine);
  let truncated = false;
  let truncatedReason = null;
  let selected = requested;
  if (selected.length > caps.maxLines) {
    selected = selected.slice(0, caps.maxLines);
    truncated = true;
    truncatedReason = 'line_cap';
  }
  const joined = Buffer.from(selected.join('\n'), 'utf8');
  const sliced = sliceUtf8(joined, caps.maxBytes);
  if (sliced.truncated) {
    truncated = true;
    truncatedReason = 'byte_cap';
  }
  const coverage = graphCoverageFromFile(file);
  return {
    path,
    sourceVersionId: scope.sourceVersionId,
    startLine,
    endLine: startLine + selected.length - 1,
    ...coverage,
    content: sliced.text,
    truncated,
    truncatedReason,
  };
}

/**
 * Registers preview routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourcePreviewRoutes(app) {
  const config = { routeAccess: 'authenticated' };
  const preHandler = requireProjectPermission('sources.preview');

  app.get('/projects/:projectId/files/slice', { config, preHandler }, async (request) => {
    const parsed = sliceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return loadSourceFileSlice({
      orgId: request.projectScope.orgId,
      projectId: request.projectScope.projectId,
      path: parsed.data.path,
      startLine: parsed.data.startLine,
      endLine: parsed.data.endLine,
    });
  });

  app.get('/projects/:projectId/files', { config, preHandler }, async (request) => {
    const parsed = metadataQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    return loadSourceFileMetadata({
      orgId: request.projectScope.orgId,
      projectId: request.projectScope.projectId,
      path: parsed.data.path,
    });
  });
}

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Loads the current source version id for a project (shared by metadata + slice).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<{ project: object, knowledgeVersion: object | null, sourceVersionId: string, knowledgeVersionId: string | null }>}
 */
async function loadCurrentSourceScope(orgId, projectId) {
  const project = await findProjectById(orgId, projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }
  const knowledgeVersionId = project.currentKnowledgeVersionId ? String(project.currentKnowledgeVersionId) : null;
  const knowledgeVersion = knowledgeVersionId
    ? await findKnowledgeVersionById({
        orgId,
        projectId,
        knowledgeVersionId,
      })
    : null;
  const sourceVersionId = knowledgeVersion?.sourceVersionId ? String(knowledgeVersion.sourceVersionId) : null;
  if (!sourceVersionId) {
    throw ApiError.fromCode('SOURCE_NOT_FOUND');
  }
  return { project, knowledgeVersion, sourceVersionId, knowledgeVersionId };
}
