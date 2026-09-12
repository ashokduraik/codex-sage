/**
 * Render allowlist for audit event `context` — secrets never reach the DOM.
 */

/**
 * Context keys the UI knows how to present (identity / authz writers today).
 * Extend only when a known backend writer adds a safe scalar key.
 */
export const AUDIT_CONTEXT_ALLOWLIST = Object.freeze([
  'previousStatus',
  'nextStatus',
  'previousEmail',
  'nextEmail',
  'roleIds',
  'addedRoleIds',
  'removedRoleIds',
  'permissionKey',
  'route',
  'method',
  'contextTruncated',
]);

const ALLOWLIST_SET = new Set(AUDIT_CONTEXT_ALLOWLIST);

/**
 * Secret-shaped key substrings (case-insensitive). Aligns with the backend sanitizer;
 * bare "key" is matched as a whole token so `permissionKey` is not false-positive.
 */
const SECRET_KEY_SUBSTRINGS = Object.freeze([
  'password',
  'token',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'privatekey',
  'cookie',
  'hash',
]);

/**
 * Returns whether a context key looks secret-shaped and must never be rendered.
 * @param {string} key Object key.
 * @returns {boolean}
 */
export function isSecretShapedAuditContextKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return true;
  }
  const lower = key.toLowerCase();
  if (SECRET_KEY_SUBSTRINGS.some((fragment) => lower.includes(fragment))) {
    return true;
  }
  return /(^|[^a-z0-9])key([^a-z0-9]|$)/.test(lower);
}

/**
 * Returns whether a value is safe to render as a context cell.
 * @param {unknown} value Candidate value.
 * @returns {boolean}
 */
function isRenderableScalar(value) {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/**
 * Filters event context down to allowlisted, non-secret, scalar (or scalar-array) entries.
 * Nested objects and unknown keys are dropped — never rendered as JSON.
 * @param {unknown} context Raw `context` from an audit event DTO.
 * @returns {Array<{ key: string, value: string | number | boolean | Array<string | number | boolean> }>}
 */
export function selectRenderableAuditContext(context) {
  if (context === undefined || context === null) {
    return [];
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    return [];
  }

  /** @type {Array<{ key: string, value: string | number | boolean | Array<string | number | boolean> }>} */
  const rows = [];

  for (const [key, raw] of Object.entries(context)) {
    if (!ALLOWLIST_SET.has(key) || isSecretShapedAuditContextKey(key)) {
      continue;
    }
    if (Array.isArray(raw)) {
      const items = raw.filter(isRenderableScalar);
      if (items.length === 0) {
        continue;
      }
      rows.push({ key, value: items });
      continue;
    }
    if (!isRenderableScalar(raw)) {
      continue;
    }
    rows.push({ key, value: raw });
  }

  return rows;
}
