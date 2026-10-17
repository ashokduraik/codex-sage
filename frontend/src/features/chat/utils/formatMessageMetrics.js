/**
 * Formats assistant message usage / duration for display — only fields the backend sent.
 * Never invents zeros or placeholder dashes for missing values.
 */

/**
 * @typedef {{
 *   durationMs?: number | null,
 *   inputTokens?: number | null,
 *   outputTokens?: number | null,
 *   totalTokens?: number | null,
 * }} FormattedMessageMetrics
 */

/**
 * Picks present metric fields from a message DTO.
 * @param {{ durationMs?: number | null, usage?: { inputTokens?: number | null, outputTokens?: number | null, totalTokens?: number | null } | null } | null | undefined} message Message DTO.
 * @returns {FormattedMessageMetrics | null} Sparse metrics object, or null when nothing to show.
 */
export function formatMessageMetrics(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  /** @type {FormattedMessageMetrics} */
  const out = {};
  if (typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) && message.durationMs >= 0) {
    out.durationMs = message.durationMs;
  }
  const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
  if (usage) {
    if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0) {
      out.inputTokens = usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
      out.outputTokens = usage.outputTokens;
    }
    if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
      out.totalTokens = usage.totalTokens;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Shortens a knowledge version id for display (never invents a human label).
 * @param {string | null | undefined} versionId Version id.
 * @returns {string} Short label or empty string.
 */
export function shortenKnowledgeVersionId(versionId) {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    return '';
  }
  const trimmed = versionId.trim();
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}
