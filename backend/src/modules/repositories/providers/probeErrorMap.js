/**
 * Maps provider HTTP / transport failures to probeStatus + reason codes.
 */

const USER_MESSAGES = Object.freeze({
  token_missing: 'This repository looks private or requires authentication.',
  token_invalid: 'The access token was rejected. Check the token and try again.',
  insufficient_scope: 'This token does not have access to the repository.',
  repository_not_found: 'The repository could not be found.',
  network_unreachable: 'The repository host could not be reached.',
  provider_unavailable: 'The repository provider is temporarily unavailable.',
  provider_rate_limited: 'The repository provider rate-limited this request. Try again later.',
  provider_not_supported: 'This host does not look like a supported GitLab instance.',
  host_not_allowed: 'This repository host is not allowed.',
});

/**
 * @typedef {{
 *   probeStatus: 'authentication_required' | 'access_denied' | 'not_found' | 'unreachable',
 *   reason: { code: string, message: string },
 * }} MappedProbeError
 */

/**
 * Maps an anonymous lookup failure.
 * @param {number} status Provider HTTP status.
 * @returns {MappedProbeError}
 */
export function mapAnonymousLookupStatus(status) {
  if (status === 401 || status === 403 || status === 404) {
    return mapped('authentication_required', 'token_missing');
  }
  return mapTransportOrUnexpected(status);
}

/**
 * Maps an authenticated lookup failure.
 * @param {number} status Provider HTTP status.
 * @returns {MappedProbeError}
 */
export function mapAuthenticatedLookupStatus(status) {
  if (status === 401) {
    return mapped('authentication_required', 'token_invalid');
  }
  if (status === 403) {
    return mapped('access_denied', 'insufficient_scope');
  }
  if (status === 404) {
    return mapped('not_found', 'repository_not_found');
  }
  return mapTransportOrUnexpected(status);
}

/**
 * Maps a thrown outbound error (timeout, host, network).
 * @param {unknown} err Thrown value.
 * @returns {MappedProbeError}
 */
export function mapOutboundThrown(err) {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String(/** @type {{ code?: unknown }} */ (err).code)
      : '';
  if (code === 'PROBE_HOST_NOT_ALLOWED') {
    return mapped('unreachable', 'host_not_allowed');
  }
  if (code === 'PROBE_TIMEOUT' || code === 'PROBE_NETWORK' || code === 'PROBE_REDIRECT') {
    return mapped('unreachable', 'network_unreachable');
  }
  if (code === 'PROBE_SIZE') {
    return mapped('unreachable', 'provider_unavailable');
  }
  return mapped('unreachable', 'provider_unavailable');
}

/**
 * Maps a non-success status that is not an auth/not-found case.
 * @param {number} status HTTP status.
 * @returns {MappedProbeError}
 */
export function mapTransportOrUnexpected(status) {
  if (status === 429) {
    return mapped('unreachable', 'provider_rate_limited');
  }
  if (status >= 500) {
    return mapped('unreachable', 'provider_unavailable');
  }
  return mapped('unreachable', 'provider_unavailable');
}

/**
 * @param {MappedProbeError['probeStatus']} probeStatus Status.
 * @param {string} reasonCode Reason code.
 * @returns {MappedProbeError}
 */
function mapped(probeStatus, reasonCode) {
  return {
    probeStatus,
    reason: {
      code: reasonCode,
      message: USER_MESSAGES[reasonCode] ?? USER_MESSAGES.provider_unavailable,
    },
  };
}
