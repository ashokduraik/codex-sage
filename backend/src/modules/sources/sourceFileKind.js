/**
 * Maps an accepted archive path to SourceFile.kind using Phase 23 allowlists.
 */
import {
  ACCEPTED_CODE_EXTENSIONS,
  ACCEPTED_CONFIG_BASENAMES,
  ACCEPTED_CONFIG_EXTENSIONS,
  ACCEPTED_DOC_EXTENSIONS,
} from './exclusions/exclusions.constants.js';

/**
 * Returns the final path segment.
 * @param {string} normalizedPath Relative path.
 * @returns {string}
 */
function basenameOf(normalizedPath) {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
}

/**
 * Lowercased extension including the leading dot, or empty string.
 * @param {string} basename File basename.
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
 * Classifies an accepted path as code, config, or doc.
 * @param {string} normalizedPath Relative archive path.
 * @returns {'code' | 'config' | 'doc'}
 */
export function kindForSourcePath(normalizedPath) {
  const basename = basenameOf(normalizedPath);
  const basenameLower = basename.toLowerCase();
  const extension = extensionOf(basename);

  if (
    ACCEPTED_CONFIG_BASENAMES.includes(basename) ||
    ACCEPTED_CONFIG_EXTENSIONS.includes(extension) ||
    ACCEPTED_CONFIG_EXTENSIONS.some((ext) => basenameLower.endsWith(ext))
  ) {
    return 'config';
  }
  if (ACCEPTED_DOC_EXTENSIONS.includes(extension)) {
    return 'doc';
  }
  if (ACCEPTED_CODE_EXTENSIONS.includes(extension)) {
    return 'code';
  }
  return 'code';
}
