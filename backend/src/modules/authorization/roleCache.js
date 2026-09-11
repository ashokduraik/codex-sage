/**
 * In-process TTL cache for role id → permission array.
 * Cross-process edits converge within RBAC_ROLE_CACHE_TTL_SECONDS.
 */

/** Worst-case staleness after a role edit on another API process (seconds). */
export const RBAC_ROLE_CACHE_TTL_SECONDS = 30;

/** Upper bound on cached role entries. */
export const RBAC_ROLE_CACHE_MAX_ENTRIES = 500;

/**
 * @typedef {object} RoleCacheEntry
 * @property {ReadonlyArray<string>} permissions
 * @property {number} expiresAtMs
 */

/**
 * Creates a role-permission cache.
 * @param {{
 *   ttlSeconds?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 * }} [options] Optional overrides for tests.
 * @returns {{
 *   get: (orgId: string, roleId: string) => ReadonlyArray<string> | undefined,
 *   set: (orgId: string, roleId: string, permissions: ReadonlyArray<string>) => void,
 *   invalidateRole: (orgId: string, roleId: string) => void,
 *   invalidateOrganization: (orgId: string) => void,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createRoleCache(options = {}) {
  const ttlSeconds = options.ttlSeconds ?? RBAC_ROLE_CACHE_TTL_SECONDS;
  const maxEntries = options.maxEntries ?? RBAC_ROLE_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, RoleCacheEntry>} */
  const store = new Map();

  /**
   * Builds a cache key.
   * @param {string} orgId Tenant id.
   * @param {string} roleId Role id.
   * @returns {string}
   */
  function cacheKey(orgId, roleId) {
    return `${orgId}:${roleId}`;
  }

  /**
   * Evicts expired entries and, if still over capacity, the oldest inserted key.
   */
  function evictIfNeeded() {
    const currentMs = now();
    for (const [key, entry] of store) {
      if (entry.expiresAtMs <= currentMs) {
        store.delete(key);
      }
    }
    while (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      store.delete(oldestKey);
    }
  }

  return {
    /**
     * Returns cached permissions when present and unexpired.
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     * @returns {ReadonlyArray<string> | undefined}
     */
    get(orgId, roleId) {
      const key = cacheKey(orgId, roleId);
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAtMs <= now()) {
        store.delete(key);
        return undefined;
      }
      // Refresh insertion order for simple LRU-ish eviction.
      store.delete(key);
      store.set(key, entry);
      return entry.permissions;
    },

    /**
     * Stores permissions for a role.
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     * @param {ReadonlyArray<string>} permissions Effective permission keys.
     */
    set(orgId, roleId, permissions) {
      evictIfNeeded();
      const key = cacheKey(orgId, roleId);
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }
      store.set(key, {
        permissions: Object.freeze([...permissions]),
        expiresAtMs: now() + ttlSeconds * 1000,
      });
    },

    /**
     * Drops one role from the cache (call after a role write).
     * @param {string} orgId Tenant id.
     * @param {string} roleId Role id.
     */
    invalidateRole(orgId, roleId) {
      store.delete(cacheKey(orgId, roleId));
    },

    /**
     * Drops every cached role for an organization.
     * @param {string} orgId Tenant id.
     */
    invalidateOrganization(orgId) {
      const prefix = `${orgId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },

    /**
     * @returns {number} Current entry count.
     */
    size() {
      return store.size;
    },

    /**
     * Clears the entire cache (tests).
     */
    clear() {
      store.clear();
    },
  };
}

/** Process-wide default cache used by the permission resolver. */
export const roleCache = createRoleCache();

/**
 * Invalidates one cached role (Phase 11 calls after role writes).
 * @param {string} orgId Tenant id.
 * @param {string} roleId Role id.
 */
export function invalidateRole(orgId, roleId) {
  roleCache.invalidateRole(orgId, roleId);
}

/**
 * Invalidates every cached role for an organization.
 * @param {string} orgId Tenant id.
 */
export function invalidateOrganization(orgId) {
  roleCache.invalidateOrganization(orgId);
}
