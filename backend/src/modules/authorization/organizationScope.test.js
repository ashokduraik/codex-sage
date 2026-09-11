import { describe, expect, it } from 'vitest';
import { assertOrganizationPathMatchesPrincipal } from './organizationScope.js';

describe('organizationScope', () => {
  it('accepts a matching path parameter', () => {
    expect(() =>
      assertOrganizationPathMatchesPrincipal('org-1', { orgId: 'org-1' }),
    ).not.toThrow();
  });

  it('rejects a differing path parameter with NOT_FOUND', () => {
    try {
      assertOrganizationPathMatchesPrincipal('other', { orgId: 'org-1' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    }
  });

  it('rejects a missing path parameter with NOT_FOUND', () => {
    try {
      assertOrganizationPathMatchesPrincipal(undefined, { orgId: 'org-1' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});
