/**
 * Named constants for source preview (not env).
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
