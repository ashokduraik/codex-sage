/**
 * Allowlist sanitizer for audit `context` and `userAgent` (backend §87, §148).
 */

/** Cap on JSON-serialized context bytes. */
export const AUDIT_CONTEXT_MAX_BYTES = 4096;

/** Cap on a single context string value (characters). */
export const AUDIT_CONTEXT_MAX_VALUE_CHARS = 512;

/** Truncation length for User-Agent headers. */
export const AUDIT_USER_AGENT_MAX_CHARS = 256;

/**
 * Forbidden key substrings (case-insensitive). Matching keys become `'[redacted]'`.
 */
const FORBIDDEN_KEY_SUBSTRINGS = Object.freeze([
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
 * Returns whether a context key name matches the hard exclusion list.
 * @param {string} key Object key.
 * @returns {boolean}
 */
function isForbiddenKey(key) {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_SUBSTRINGS.some((fragment) => lower.includes(fragment));
}

/**
 * Returns whether a value is an allowed scalar for audit context.
 * @param {unknown} value Candidate value.
 * @returns {boolean}
 */
function isAllowedScalar(value) {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/**
 * Truncates a string to max characters.
 * @param {string} value Source string.
 * @param {number} maxChars Max length.
 * @returns {{ value: string, truncated: boolean }}
 */
function truncateString(value, maxChars) {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}

/**
 * Sanitizes optional User-Agent header text.
 * @param {unknown} userAgent Raw header.
 * @returns {string | undefined}
 */
export function sanitizeUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.length === 0) {
    return undefined;
  }
  return truncateString(userAgent, AUDIT_USER_AGENT_MAX_CHARS).value;
}

/**
 * Sanitizes audit context: allowlist scalars / depth-1 scalar arrays; redact secrets;
 * enforce size caps. Nested objects and functions are dropped.
 * @param {unknown} context Caller-supplied metadata.
 * @returns {Record<string, unknown> | undefined}
 */
export function sanitizeAuditContext(context) {
  if (context === undefined || context === null) {
    return undefined;
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  const out = {};
  let truncated = false;

  for (const [key, raw] of Object.entries(context)) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    if (isForbiddenKey(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (Array.isArray(raw)) {
      /** @type {Array<string | number | boolean>} */
      const items = [];
      for (const item of raw) {
        if (!isAllowedScalar(item)) {
          truncated = true;
          continue;
        }
        if (typeof item === 'string') {
          const next = truncateString(item, AUDIT_CONTEXT_MAX_VALUE_CHARS);
          items.push(next.value);
          if (next.truncated) {
            truncated = true;
          }
        } else {
          items.push(item);
        }
      }
      out[key] = items;
      continue;
    }
    if (!isAllowedScalar(raw)) {
      // Nested objects, functions, null, symbols — drop (do not store).
      truncated = true;
      continue;
    }
    if (typeof raw === 'string') {
      const next = truncateString(raw, AUDIT_CONTEXT_MAX_VALUE_CHARS);
      out[key] = next.value;
      if (next.truncated) {
        truncated = true;
      }
    } else {
      out[key] = raw;
    }
  }

  if (truncated) {
    out.contextTruncated = true;
  }

  let serialized = JSON.stringify(out);
  if (Buffer.byteLength(serialized, 'utf8') > AUDIT_CONTEXT_MAX_BYTES) {
    out.contextTruncated = true;
    // Drop non-essential keys until under the byte cap (keep redaction markers).
    const keys = Object.keys(out).filter((key) => key !== 'contextTruncated');
    while (
      keys.length > 0 &&
      Buffer.byteLength(JSON.stringify(out), 'utf8') > AUDIT_CONTEXT_MAX_BYTES
    ) {
      const dropKey = keys.pop();
      if (dropKey) {
        delete out[dropKey];
      }
    }
    serialized = JSON.stringify(out);
    if (Buffer.byteLength(serialized, 'utf8') > AUDIT_CONTEXT_MAX_BYTES) {
      return { contextTruncated: true };
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
