/**
 * Exclusion ruleset v1 constants — caps, ignore lists, and allowlists.
 * Tunables live here (not env). Phase 24 persists EXCLUSION_RULESET_ID on SourceVersion.
 */

/** Recorded on SourceVersion so S2 can replay the same rules. */
export const EXCLUSION_RULESET_ID = 'exclusions.v1';

/** Files larger than this are stored but excluded from the code graph (1 MiB). */
export const GRAPH_FILE_MAX_BYTES = 1_048_576;

/** Maximum accepted archive size before listing (500 MiB). */
export const UPLOAD_MAX_ARCHIVE_BYTES = 524_288_000;

/** Maximum number of zip entries to list before failing closed. */
export const UPLOAD_MAX_ENTRY_COUNT = 100_000;

/** Directory prefixes skipped before GridFS (solution §4.2). */
export const IGNORED_PATH_PREFIXES = Object.freeze([
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
]);

/** Image extensions skipped entirely (not stored). */
export const IGNORED_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svg',
]);

/** Exact basenames always skipped. */
export const IGNORED_BASENAMES = Object.freeze(['.DS_Store']);

/** Suffixes for minified assets skipped as junk. */
export const IGNORED_FILE_SUFFIXES = Object.freeze(['.min.js', '.min.css']);

/** Code extensions accepted for storage and (when under size) graph indexing. */
export const ACCEPTED_CODE_EXTENSIONS = Object.freeze([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
]);

/** Documentation extensions accepted for storage / FTS. */
export const ACCEPTED_DOC_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt']);

/** Config extensions accepted for bounded reads (not assumed graph nodes). */
export const ACCEPTED_CONFIG_EXTENSIONS = Object.freeze([
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env.example',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
]);

/** Exact config basenames (may carry compound extensions). */
export const ACCEPTED_CONFIG_BASENAMES = Object.freeze([
  '.prettierrc',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
]);
