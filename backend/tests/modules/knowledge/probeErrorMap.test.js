/**
 * Unit tests for probe status mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  mapAnonymousLookupStatus,
  mapAuthenticatedLookupStatus,
  mapOutboundThrown,
  mapTransportOrUnexpected,
} from '../../../src/modules/knowledge/repositories.helper.js';

describe('probeErrorMap', () => {
  it('maps anonymous 404 to authentication_required', () => {
    expect(mapAnonymousLookupStatus(404)).toMatchObject({
      probeStatus: 'authentication_required',
      reason: { code: 'token_missing' },
    });
    expect(mapAnonymousLookupStatus(401).probeStatus).toBe('authentication_required');
    expect(mapAnonymousLookupStatus(403).probeStatus).toBe('authentication_required');
  });

  it('maps authenticated 404 / 403 / 401 distinctly', () => {
    expect(mapAuthenticatedLookupStatus(404)).toMatchObject({
      probeStatus: 'not_found',
      reason: { code: 'repository_not_found' },
    });
    expect(mapAuthenticatedLookupStatus(403)).toMatchObject({
      probeStatus: 'access_denied',
      reason: { code: 'insufficient_scope' },
    });
    expect(mapAuthenticatedLookupStatus(401)).toMatchObject({
      probeStatus: 'authentication_required',
      reason: { code: 'token_invalid' },
    });
  });

  it('maps timeouts, 5xx, rate limits, and unknown statuses to unreachable', () => {
    expect(mapOutboundThrown({ code: 'PROBE_TIMEOUT' })).toMatchObject({
      probeStatus: 'unreachable',
      reason: { code: 'network_unreachable' },
    });
    expect(mapOutboundThrown({ code: 'PROBE_HOST_NOT_ALLOWED' }).reason.code).toBe('host_not_allowed');
    expect(mapOutboundThrown(new Error('nope')).reason.code).toBe('provider_unavailable');
    expect(mapTransportOrUnexpected(503).reason.code).toBe('provider_unavailable');
    expect(mapTransportOrUnexpected(429).reason.code).toBe('provider_rate_limited');
    expect(mapTransportOrUnexpected(418).probeStatus).toBe('unreachable');
  });
});
