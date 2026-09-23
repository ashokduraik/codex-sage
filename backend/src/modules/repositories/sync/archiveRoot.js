/**
 * Strips the single top-level folder GitHub/GitLab archives wrap around the tree.
 */

/**
 * Builds a rewriter that drops a shared first path segment when every entry
 * lives under that folder (e.g. `repo-sha/src/a.js` → `src/a.js`).
 * @param {string[]} paths Normalized archive paths.
 * @returns {(path: string) => string}
 */
export function createArchiveRootRewriter(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return (path) => path;
  }
  const firstSegments = paths.map((path) => {
    const slash = path.indexOf('/');
    return slash === -1 ? path : path.slice(0, slash);
  });
  const root = firstSegments[0];
  const shared = Boolean(root) && firstSegments.every((segment) => segment === root);
  const hasNested = paths.some((path) => path.includes('/'));
  if (!shared || !hasNested) {
    return (path) => path;
  }
  const prefix = `${root}/`;
  return (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);
}
