/**
 * Path normalization and zip-slip / duplicate-path safety checks.
 */
import { ApiError } from '../../../platform/errors.js';

/**
 * Normalizes an archive entry path: backslashes to `/`, strip leading `./`,
 * collapse duplicate slashes, and drop a trailing slash for file comparisons.
 * @param {string} rawPath Raw zip entry path.
 * @returns {string} Normalized relative path using `/`.
 */
export function normalizeArchivePath(rawPath) {
  if (typeof rawPath !== 'string') {
    return '';
  }
  let path = rawPath.replace(/\\/g, '/');
  path = path.replace(/^\.\/+/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/**
 * Returns true when the normalized path is absolute, contains `..`, or has a
 * Windows drive prefix.
 * @param {string} normalizedPath Path already passed through {@link normalizeArchivePath}.
 * @returns {boolean}
 */
export function isUnsafeArchivePath(normalizedPath) {
  if (!normalizedPath) {
    return true;
  }
  if (normalizedPath.startsWith('/')) {
    return true;
  }
  if (/^[a-zA-Z]:/.test(normalizedPath)) {
    return true;
  }
  const segments = normalizedPath.split('/');
  return segments.some((segment) => segment === '..');
}

/**
 * Asserts that a normalized path is safe for extraction; throws SOURCE_ZIP_SLIP otherwise.
 * @param {string} normalizedPath Normalized entry path.
 * @returns {void}
 * @throws {ApiError}
 */
export function assertSafeArchivePath(normalizedPath) {
  if (isUnsafeArchivePath(normalizedPath)) {
    throw ApiError.fromCode('SOURCE_ZIP_SLIP');
  }
}

/**
 * Tracks seen normalized paths and throws on collision.
 * @returns {{ remember: (normalizedPath: string) => void }}
 */
export function createDuplicatePathGuard() {
  const seen = new Set();
  return {
    /**
     * @param {string} normalizedPath
     * @returns {void}
     * @throws {ApiError}
     */
    remember(normalizedPath) {
      if (seen.has(normalizedPath)) {
        throw ApiError.fromCode('SOURCE_ZIP_SLIP');
      }
      seen.add(normalizedPath);
    },
  };
}
