/**
 * Resolves which project the processing center / header chip should use.
 */

/**
 * Picks a project id from the processing query string or a project route.
 * @param {{
 *   pathname?: string,
 *   params?: { id?: string },
 *   searchParams?: { get: (key: string) => string | null },
 * }} input Location pieces.
 * @returns {string} Project id, or empty when none is in context.
 */
export function resolveProcessingProjectId(input) {
  const fromQuery = input.searchParams?.get('projectId');
  if (fromQuery && fromQuery.trim()) {
    return fromQuery.trim();
  }
  const pathname = input.pathname || '';
  if (pathname.startsWith('/projects/')) {
    const fromParams = input.params?.id;
    if (fromParams && String(fromParams).trim()) {
      return String(fromParams).trim();
    }
    const segment = pathname.split('/')[2];
    return segment && segment.trim() ? segment.trim() : '';
  }
  return '';
}
