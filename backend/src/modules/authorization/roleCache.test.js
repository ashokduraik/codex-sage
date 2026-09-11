import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoleCache } from './roleCache.js';

describe('roleCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a cached value inside the TTL and refetches after expiry', () => {
    vi.useFakeTimers();
    const now = { ms: 1_000_000 };
    const cache = createRoleCache({
      ttlSeconds: 30,
      now: () => now.ms,
    });
    cache.set('org1', 'role1', ['org.view']);
    expect(cache.get('org1', 'role1')).toEqual(['org.view']);
    now.ms += 29_000;
    expect(cache.get('org1', 'role1')).toEqual(['org.view']);
    now.ms += 2_000;
    expect(cache.get('org1', 'role1')).toBeUndefined();
  });

  it('drops an entry on invalidateRole', () => {
    const cache = createRoleCache();
    cache.set('org1', 'role1', ['org.view']);
    cache.invalidateRole('org1', 'role1');
    expect(cache.get('org1', 'role1')).toBeUndefined();
  });

  it('drops every role for an organization on invalidateOrganization', () => {
    const cache = createRoleCache();
    cache.set('org1', 'role1', ['org.view']);
    cache.set('org1', 'role2', ['chat.ask']);
    cache.set('org2', 'role3', ['search.run']);
    cache.invalidateOrganization('org1');
    expect(cache.get('org1', 'role1')).toBeUndefined();
    expect(cache.get('org1', 'role2')).toBeUndefined();
    expect(cache.get('org2', 'role3')).toEqual(['search.run']);
  });

  it('respects RBAC_ROLE_CACHE_MAX_ENTRIES', () => {
    const cache = createRoleCache({ maxEntries: 2 });
    cache.set('org1', 'a', ['a']);
    cache.set('org1', 'b', ['b']);
    cache.set('org1', 'c', ['c']);
    expect(cache.size()).toBeLessThanOrEqual(2);
    expect(cache.get('org1', 'c')).toEqual(['c']);
  });
});
