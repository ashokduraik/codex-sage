import { describe, it, expect } from 'vitest';
import {
  CORRELATION_ID_PREFIX,
  generateCorrelationId,
  getCorrelationId,
  getRequestContext,
  runWithRequestContext,
} from './requestContext.js';

describe('generateCorrelationId', () => {
  it('uses the configured prefix and a stable 32-hex length', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(new RegExp(`^${CORRELATION_ID_PREFIX}-[0-9a-f]{32}$`));
  });

  it('does not collide across many generations', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      seen.add(generateCorrelationId());
    }
    expect(seen.size).toBe(200);
  });
});

describe('requestContext store', () => {
  it('returns undefined outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('keeps interleaved async flows separate', async () => {
    const results = await Promise.all([
      new Promise((resolve) => {
        runWithRequestContext({ correlationId: 'REQ-aaaa' }, () => {
          setTimeout(() => {
            resolve(getCorrelationId());
          }, 20);
        });
      }),
      new Promise((resolve) => {
        runWithRequestContext({ correlationId: 'REQ-bbbb' }, () => {
          setTimeout(() => {
            resolve(getCorrelationId());
          }, 5);
        });
      }),
    ]);
    expect(results).toEqual(['REQ-aaaa', 'REQ-bbbb']);
  });

  it('exposes optional tenant fields when present', () => {
    runWithRequestContext(
      {
        correlationId: 'REQ-cccc',
        organizationId: 'org-1',
        userId: 'user-1',
      },
      () => {
        expect(getRequestContext()).toEqual({
          correlationId: 'REQ-cccc',
          organizationId: 'org-1',
          userId: 'user-1',
        });
      },
    );
  });
});
