/**
 * Unit tests for project ACL cache helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  createProjectAclCache,
  invalidateProjectAclCache,
  projectAclCache,
} from '../../../src/modules/masters/projectMembers.js';

describe('projectAclCache', () => {
  it('stores, returns, and expires entries; respects aclVersion', () => {
    let nowMs = 1_000;
    const cache = createProjectAclCache({
      enabled: true,
      ttlMs: 100,
      maxEntries: 2,
      now: () => nowMs,
    });

    cache.set('o1', 'u1', 'p1', { kind: 'OK', permissions: ['projects.view'], aclVersion: 1 });
    expect(cache.get('o1', 'u1', 'p1', 1)?.permissions).toEqual(['projects.view']);
    expect(cache.get('o1', 'u1', 'p1', 2)).toBeUndefined();

    cache.set('o1', 'u1', 'p1', { kind: 'OK', permissions: ['projects.view'], aclVersion: 2 });
    cache.set('o1', 'u2', 'p1', { kind: 'NO_ACCESS', aclVersion: 2 });
    cache.set('o1', 'u3', 'p1', { kind: 'NO_ACCESS', aclVersion: 2 });
    expect(cache.size()).toBeLessThanOrEqual(2);

    nowMs = 2_000;
    expect(cache.get('o1', 'u3', 'p1', 2)).toBeUndefined();

    cache.set('o2', 'u1', 'p1', { kind: 'NO_ACCESS', aclVersion: 0 });
    cache.invalidateOrganization('o2');
    expect(cache.get('o2', 'u1', 'p1', 0)).toBeUndefined();
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.isEnabled()).toBe(true);
  });

  it('no-ops when disabled and exposes process cache helpers', () => {
    const disabled = createProjectAclCache({ enabled: false });
    disabled.set('o', 'u', 'p', { kind: 'NO_ACCESS', aclVersion: 0 });
    expect(disabled.get('o', 'u', 'p', 0)).toBeUndefined();
    expect(disabled.isEnabled()).toBe(false);

    expect(projectAclCache.isEnabled()).toBe(false);
    projectAclCache.setEnabled(true);
    expect(projectAclCache.isEnabled()).toBe(true);
    projectAclCache.set('ox', 'ux', 'px', { kind: 'NO_ACCESS', aclVersion: 0 });
    projectAclCache.setEnabled(false);
    expect(projectAclCache.isEnabled()).toBe(false);
    expect(projectAclCache.size()).toBe(0);
    invalidateProjectAclCache('any');
  });
});
