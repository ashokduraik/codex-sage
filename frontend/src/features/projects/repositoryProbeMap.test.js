/**
 * Probe status mapping and token-page URL construction.
 */
import { describe, expect, it } from 'vitest';
import { mapProbeResult, tokenPageUrl } from './repositoryProbeMap.js';

describe('mapProbeResult', () => {
  it('maps connected to confirm', () => {
    expect(
      mapProbeResult({
        probeStatus: 'connected',
        repository: { fullName: 'acme/atlas' },
        defaultBranch: 'main',
      }),
    ).toMatchObject({
      step: 'confirm',
      status: 'connected',
      messageKey: 'sources.verified',
      fullName: 'acme/atlas',
    });
  });

  it('maps authentication_required to token and names the repo', () => {
    expect(
      mapProbeResult({
        probeStatus: 'authentication_required',
        repository: { fullName: 'acme/private' },
        reason: { code: 'token_missing' },
      }),
    ).toMatchObject({
      step: 'token',
      status: 'authentication_required',
      reasonCode: 'token_missing',
      messageKey: 'sources.authRequiredNamed',
      fullName: 'acme/private',
    });
  });

  it('maps access_denied, not_found, and unreachable to error keys', () => {
    expect(
      mapProbeResult({
        probeStatus: 'access_denied',
        reason: { code: 'insufficient_scope' },
      }),
    ).toMatchObject({
      step: 'error',
      messageKey: 'sources.probeReasonInsufficientScope',
    });
    expect(
      mapProbeResult({
        probeStatus: 'not_found',
        reason: { code: 'repository_not_found' },
      }),
    ).toMatchObject({
      step: 'error',
      messageKey: 'sources.probeReasonNotFound',
    });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'network_unreachable' },
      }),
    ).toMatchObject({
      step: 'error',
      messageKey: 'sources.probeReasonUnreachable',
    });
  });

  it('falls back for unknown status and unknown reason codes', () => {
    expect(mapProbeResult({ probeStatus: 'mystery' })).toMatchObject({
      step: 'error',
      status: 'unknown',
      messageKey: 'sources.probeUnknown',
    });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'brand_new_reason' },
      }),
    ).toMatchObject({
      step: 'error',
      status: 'unreachable',
      messageKey: 'sources.probeUnreachable',
    });
    expect(mapProbeResult(null)).toMatchObject({
      step: 'error',
      status: 'unknown',
      messageKey: 'sources.probeUnknown',
    });
  });

  it('maps remaining reason codes', () => {
    expect(
      mapProbeResult({
        probeStatus: 'authentication_required',
        reason: { code: 'token_invalid' },
      }),
    ).toMatchObject({ messageKey: 'sources.probeReasonTokenInvalid', step: 'token' });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'provider_unavailable' },
      }),
    ).toMatchObject({ messageKey: 'sources.probeReasonUnavailable' });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'provider_rate_limited' },
      }),
    ).toMatchObject({ messageKey: 'sources.probeReasonRateLimited' });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'provider_not_supported' },
      }),
    ).toMatchObject({ messageKey: 'sources.probeReasonNotSupported' });
    expect(
      mapProbeResult({
        probeStatus: 'unreachable',
        reason: { code: 'host_not_allowed' },
      }),
    ).toMatchObject({ messageKey: 'sources.probeReasonHostNotAllowed' });
  });
});

describe('tokenPageUrl', () => {
  it('uses GitHub settings for github and GitLab self-hosted baseUrl', () => {
    expect(tokenPageUrl({ provider: 'github' })).toBe(
      'https://github.com/settings/tokens/new',
    );
    expect(
      tokenPageUrl({
        provider: 'gitlab',
        hostKind: 'gitlab_self_hosted',
        baseUrl: 'https://gitlab.acme.io/',
      }),
    ).toBe('https://gitlab.acme.io/-/user_settings/personal_access_tokens');
    expect(tokenPageUrl({ provider: 'gitlab', hostKind: 'gitlab_dotcom' })).toBe(
      'https://gitlab.com/-/user_settings/personal_access_tokens',
    );
  });
});
