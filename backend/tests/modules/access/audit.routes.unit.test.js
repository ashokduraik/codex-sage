/**
 * Unit tests for audit HTTP validation edge paths.
 */
import { describe, expect, it } from 'vitest';
import { listAuditEventsHttp, getAuditEventHttp, assertAuditListDateRange } from '../../../src/modules/access/audit.js';

describe('audit Http unit edges', () => {
  it('rejects empty detail params via VALIDATION_ERROR', async () => {
    await expect(
      getAuditEventHttp({
        params: { auditEventId: '' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a from/to span longer than 31 days via VALIDATION_ERROR', async () => {
    await expect(
      listAuditEventsHttp({
        query: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects to before from via VALIDATION_ERROR', async () => {
    expect(() => assertAuditListDateRange(new Date('2026-09-12T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z'))).toThrow();
    expect(() => assertAuditListDateRange(new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-02T00:00:00.000Z'))).not.toThrow();
    expect(() => assertAuditListDateRange(undefined, new Date('2026-09-01T00:00:00.000Z'))).not.toThrow();
  });

  it('rejects invalid to query via VALIDATION_ERROR', async () => {
    await expect(
      listAuditEventsHttp({
        query: { to: 'definitely-not-a-date' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
