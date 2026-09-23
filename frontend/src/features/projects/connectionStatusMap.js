/**
 * Maps repository connectionStatus codes to i18n keys.
 */

/** @type {Readonly<Record<string, string>>} */
export const CONNECTION_STATUS_LABEL_KEYS = Object.freeze({
  connected: 'sources.connectionStatus.connected',
  authentication_required: 'sources.connectionStatus.authenticationRequired',
  access_denied: 'sources.connectionStatus.accessDenied',
  not_found: 'sources.connectionStatus.notFound',
  unreachable: 'sources.connectionStatus.unreachable',
});

/**
 * i18n key for a connection status, or the unknown fallback.
 * @param {string | null | undefined} code Backend connectionStatus.
 * @returns {string}
 */
export function connectionStatusLabelKey(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return 'sources.connectionStatus.unknown';
  }
  return CONNECTION_STATUS_LABEL_KEYS[code] ?? 'sources.connectionStatus.unknown';
}
