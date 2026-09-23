/**
 * Maps backend probeStatus + reason.code to UI step and i18n keys.
 */

/** Known probe statuses from Phase 30. */
export const KNOWN_PROBE_STATUSES = Object.freeze([
  'connected',
  'authentication_required',
  'access_denied',
  'not_found',
  'unreachable',
]);

const PROBE_STATUS_MESSAGE_KEYS = Object.freeze({
  connected: 'sources.verified',
  authentication_required: 'sources.authRequired',
  access_denied: 'sources.probeAccessDenied',
  not_found: 'sources.probeNotFound',
  unreachable: 'sources.probeUnreachable',
});

const REASON_MESSAGE_KEYS = Object.freeze({
  token_missing: 'sources.probeReasonTokenMissing',
  token_invalid: 'sources.probeReasonTokenInvalid',
  insufficient_scope: 'sources.probeReasonInsufficientScope',
  repository_not_found: 'sources.probeReasonNotFound',
  network_unreachable: 'sources.probeReasonUnreachable',
  provider_unavailable: 'sources.probeReasonUnavailable',
  provider_rate_limited: 'sources.probeReasonRateLimited',
  provider_not_supported: 'sources.probeReasonNotSupported',
  host_not_allowed: 'sources.probeReasonHostNotAllowed',
});

/**
 * Maps a probe DTO to the next dialog step and a localized message key.
 * Never returns raw provider text.
 * @param {import('./api/repositoryTypes.js').RepositoryProbeDto | null | undefined} probe
 *   Probe response.
 * @returns {{
 *   step: 'confirm' | 'token' | 'error',
 *   status: string,
 *   reasonCode: string | null,
 *   messageKey: string,
 *   fullName: string | null,
 * }}
 */
export function mapProbeResult(probe) {
  const rawStatus = probe && typeof probe.probeStatus === 'string' ? probe.probeStatus : '';
  const status = KNOWN_PROBE_STATUSES.includes(rawStatus) ? rawStatus : 'unknown';
  const step =
    status === 'connected'
      ? 'confirm'
      : status === 'authentication_required'
        ? 'token'
        : 'error';
  const reasonCode =
    probe?.reason && typeof probe.reason.code === 'string' ? probe.reason.code : null;
  const fullName =
    probe?.repository && typeof probe.repository.fullName === 'string'
      ? probe.repository.fullName
      : null;
  let messageKey = REASON_MESSAGE_KEYS[reasonCode] ?? PROBE_STATUS_MESSAGE_KEYS[status];
  if (!messageKey) {
    messageKey = 'sources.probeUnknown';
  }
  if (status === 'authentication_required' && fullName && reasonCode === 'token_missing') {
    messageKey = 'sources.authRequiredNamed';
  }
  return { step, status, reasonCode, messageKey, fullName };
}

/**
 * Builds the provider token-settings URL from probe identity.
 * @param {{
 *   provider?: string,
 *   hostKind?: string,
 *   baseUrl?: string | null,
 * }} identity Probe identity fields.
 * @returns {string}
 */
export function tokenPageUrl(identity) {
  if (identity.provider === 'github') {
    return 'https://github.com/settings/tokens/new';
  }
  const base =
    identity.hostKind === 'gitlab_self_hosted' && typeof identity.baseUrl === 'string'
      ? identity.baseUrl.replace(/\/+$/, '')
      : '';
  if (base) {
    return `${base}/-/user_settings/personal_access_tokens`;
  }
  return 'https://gitlab.com/-/user_settings/personal_access_tokens';
}
