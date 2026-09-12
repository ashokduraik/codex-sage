/**
 * Per-entry accept / skip / exclude-from-graph decisions for upload paths.
 */
import {
  ACCEPTED_CODE_EXTENSIONS,
  ACCEPTED_CONFIG_BASENAMES,
  ACCEPTED_CONFIG_EXTENSIONS,
  ACCEPTED_DOC_EXTENSIONS,
  GRAPH_FILE_MAX_BYTES,
  IGNORED_BASENAMES,
  IGNORED_FILE_SUFFIXES,
  IGNORED_IMAGE_EXTENSIONS,
  IGNORED_PATH_PREFIXES,
} from './exclusions.constants.js';
import { normalizeArchivePath } from './pathSafety.js';

/**
 * Returns the final path segment of a normalized path.
 * @param {string} normalizedPath
 * @returns {string}
 */
function basenameOf(normalizedPath) {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
}

/**
 * True when any path segment (as a directory prefix) matches an ignored prefix.
 * @param {string} normalizedPath
 * @returns {boolean}
 */
function matchesIgnoredDirectory(normalizedPath) {
  const withSlash = normalizedPath.endsWith('/')
    ? normalizedPath
    : `${normalizedPath}/`;
  for (const prefix of IGNORED_PATH_PREFIXES) {
    if (withSlash.startsWith(prefix) || withSlash.includes(`/${prefix}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Lowercased extension including the leading dot, or empty string.
 * @param {string} basename
 * @returns {string}
 */
function extensionOf(basename) {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return basename.slice(dot).toLowerCase();
}

/**
 * True when the basename ends with an ignored minified suffix.
 * @param {string} basenameLower
 * @returns {boolean}
 */
function matchesIgnoredSuffix(basenameLower) {
  return IGNORED_FILE_SUFFIXES.some((suffix) => basenameLower.endsWith(suffix));
}

/**
 * True when the path is an allowlisted code, doc, or config file.
 * @param {string} basename
 * @param {string} extension
 * @returns {boolean}
 */
function isAllowlistedSourceFile(basename, extension) {
  if (ACCEPTED_CONFIG_BASENAMES.includes(basename)) {
    return true;
  }
  if (ACCEPTED_CODE_EXTENSIONS.includes(extension)) {
    return true;
  }
  if (ACCEPTED_DOC_EXTENSIONS.includes(extension)) {
    return true;
  }
  if (ACCEPTED_CONFIG_EXTENSIONS.includes(extension)) {
    return true;
  }
  // Compound config extensions such as `.env.example` (extensionOf returns `.example`).
  const basenameLower = basename.toLowerCase();
  return ACCEPTED_CONFIG_EXTENSIONS.some((ext) => basenameLower.endsWith(ext));
}

/**
 * Decides whether an upload entry is accepted, skipped, or stored but excluded
 * from the code graph.
 * @param {{ path: string, uncompressedSize: number }} entry Entry metadata.
 * @returns {{ decision: 'accept' | 'accept_excluded_from_graph' | 'skip', reasonCode?: string }}
 */
export function evaluateUploadEntry(entry) {
  const normalizedPath = normalizeArchivePath(entry.path);
  const basename = basenameOf(normalizedPath);
  const basenameLower = basename.toLowerCase();
  const extension = extensionOf(basename);

  if (matchesIgnoredDirectory(normalizedPath)) {
    return { decision: 'skip', reasonCode: 'ignored_directory' };
  }

  if (IGNORED_BASENAMES.includes(basename) || matchesIgnoredSuffix(basenameLower)) {
    return { decision: 'skip', reasonCode: 'ignored_file' };
  }

  if (IGNORED_IMAGE_EXTENSIONS.includes(extension)) {
    return { decision: 'skip', reasonCode: 'ignored_image' };
  }

  if (!isAllowlistedSourceFile(basename, extension)) {
    return { decision: 'skip', reasonCode: 'unsupported_extension' };
  }

  const size =
    typeof entry.uncompressedSize === 'number' && Number.isFinite(entry.uncompressedSize)
      ? entry.uncompressedSize
      : 0;

  if (size > GRAPH_FILE_MAX_BYTES) {
    return {
      decision: 'accept_excluded_from_graph',
      reasonCode: 'file_too_large',
    };
  }

  return { decision: 'accept' };
}
