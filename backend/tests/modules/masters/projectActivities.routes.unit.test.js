/**
 * Usage route validation edges.
 */
import { describe, expect, it, vi } from 'vitest';
import { getOrganizationUsageHttp, getProjectUsageHttp } from '../../../src/modules/masters/projectActivities.js';

const { resolveAccessibleProjectFilterMock } = vi.hoisted(() => ({
  resolveAccessibleProjectFilterMock: vi.fn(async () => ({ mode: 'all' })),
}));

vi.mock('../../../src/modules/masters/projectMembers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveAccessibleProjectFilter: resolveAccessibleProjectFilterMock,
  };
});

describe('projectActivities.routes unit edges', () => {
  it('rejects invalid from/to and missing projectId', async () => {
    const principal = { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' };
    await expect(
      getOrganizationUsageHttp({
        query: { from: 'not-a-date' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      getOrganizationUsageHttp({
        query: { to: 'also-bad' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      getProjectUsageHttp({
        params: { projectId: '' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      getProjectUsageHttp({
        params: { projectId: '507f1f77bcf86cd799439011' },
        query: { from: 'bad' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
