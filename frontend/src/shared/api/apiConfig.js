/**
 * Resolves and validates the Vite-injected API base URL.
 * This is the only module that reads `import.meta.env.VITE_API_BASE_URL`.
 */

const ENV_KEY = 'VITE_API_BASE_URL';

/**
 * Validates a raw base URL string and returns a trimmed value without a trailing slash.
 * Accepts a same-origin path starting with `/` or an absolute `http(s)` URL.
 * @param {unknown} raw Value from `import.meta.env.VITE_API_BASE_URL`.
 * @returns {string} Normalized base URL.
 * @throws {Error} When missing or malformed; message names `VITE_API_BASE_URL`.
 */
export function resolveApiBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${ENV_KEY} is missing or empty`);
  }
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('/')) {
    if (trimmed.includes('://')) {
      throw new Error(`${ENV_KEY} is malformed: expected a path or http(s) URL`);
    }
    return trimmed;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${ENV_KEY} is malformed: expected a path or http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${ENV_KEY} is malformed: expected a path or http(s) URL`);
  }
  return trimmed;
}

/** Validated API base URL for every backend call. */
export const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
