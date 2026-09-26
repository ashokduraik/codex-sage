/**
 * Format an ISO timestamp as a short relative string (e.g. "3h ago").
 *
 * @param iso - ISO-8601 date string, or null/undefined
 * @returns Relative label, or an em dash when missing
 */
export function formatRelative(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diffSeconds = (now.getTime() - date.getTime()) / 1000;
  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
/**
 * Format an ISO timestamp as a localized short date-time.
 *
 * @param iso - ISO-8601 date string, or null/undefined
 * @returns Localized date-time, or an em dash when missing
 */
export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
