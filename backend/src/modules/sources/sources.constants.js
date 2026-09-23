/**
 * Source upload persistence constants (not env).
 */

/** GridFS bucket for accepted source/doc bytes. */
export const GRIDFS_SOURCE_BUCKET = 'sourceFiles';

/** Content hash algorithm for accepted files and archive identity. */
export const UPLOAD_HASH_ALGORITHM = 'sha256';

/** Multipart allows a single archive field. */
export const MULTIPART_MAX_FILES = 1;

/** Multipart form field name for the zip archive. */
export const ARCHIVE_FIELD_NAME = 'archive';

/** SourceVersion.origin for this upload path. */
export const SOURCE_ORIGIN_UPLOAD = 'upload';

/** SourceVersion.origin for a repository snapshot. */
export const SOURCE_ORIGIN_REPOSITORY = 'repository';

/** SourceVersion.versionLifecycle values (domain; not row status). */
export const VERSION_LIFECYCLE_VALUES = Object.freeze([
  'received',
  'failed',
  'accepted',
]);

/** Initial versionLifecycle after a successful upload write. */
export const VERSION_LIFECYCLE_RECEIVED = 'received';

/** SourceFile.kind values. */
export const SOURCE_FILE_KIND_VALUES = Object.freeze(['code', 'config', 'doc']);

/** SourceFile.fileState values (Phase 25 S1 may change). */
export const SOURCE_FILE_STATE_VALUES = Object.freeze([
  'stored',
  'missing',
  'corrupt',
]);

/** Default fileState after a successful GridFS write. */
export const SOURCE_FILE_STATE_STORED = 'stored';

/** FileState when the GridFS object is missing. */
export const SOURCE_FILE_STATE_MISSING = 'missing';

/** FileState when length or sha256 does not match. */
export const SOURCE_FILE_STATE_CORRUPT = 'corrupt';

/** Default page size for GET /projects/:projectId/source-versions. */
export const SOURCE_VERSION_LIST_PAGE_SIZE_DEFAULT = 20;

/** Hard cap on the source-versions `limit` query parameter. */
export const SOURCE_VERSION_LIST_PAGE_SIZE_MAX = 100;
