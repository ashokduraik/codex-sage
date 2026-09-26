import path from 'node:path';

/**
 * Quotes a path so spaces and quotes survive the shell.
 * @param {string} filePath File path to quote.
 * @returns {string}
 */
function quoteShellPath(filePath) {
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds an eslint --fix command that runs inside one app directory.
 * @param {string} app App directory name (`frontend` or `backend`).
 * @param {string[]} filenames Staged paths relative to the repo root or absolute.
 * @returns {string}
 */
function eslintFixCommand(app, filenames) {
  const appRoot = path.resolve(app);
  const relativeFiles = filenames
    .map((filePath) => path.relative(appRoot, path.resolve(filePath)))
    .map(quoteShellPath)
    .join(' ');
  return `cd ${quoteShellPath(app)} && ./node_modules/.bin/eslint --fix -- ${relativeFiles}`;
}

export default {
  'frontend/**/*.{js,jsx}': (filenames) => eslintFixCommand('frontend', filenames),
  'backend/**/*.js': (filenames) => eslintFixCommand('backend', filenames),
  '**/*.{js,jsx,json,md,css,yml,yaml}': 'prettier --write',
};
