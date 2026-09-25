/**
 * Process-local TTL cache for resolved project ACL entries.
 * Entries are tagged with organization.aclVersion; stale versions are discarded on read.
 */
import { bumpOrganizationAclVersion } from '../identity/organization.repository.js';

/** Worst-case staleness when aclVersion is unchanged (milliseconds). */
export const PROJECT_ACL_CACHE_TTL_MS = 5000;

/** Upper bound on cached ACL entries. */
export const PROJECT_ACL_CACHE_MAX_ENTRIES = 5000;

/**
 * @typedef {object} ProjectAclCacheValue
 * @property {'NO_ACCESS' | 'OK'} kind
 * @property {string[]} [permissions]
 * @property {number} aclVersion
 */

/**
 * @typedef {object} ProjectAclCacheEntry
 * @property {ProjectAclCacheValue} value
 * @property {number} expiresAtMs
 */

/**
 * Creates a project-ACL cache.
 * @param {{
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 *   enabled?: boolean,
 * }} [options] Optional overrides for tests.
 * @returns {{
 *   get: (orgId: string, userId: string, projectId: string, aclVersion: number) =>
 *     ProjectAclCacheValue | undefined,
 *   set: (
 *     orgId: string,
 *     userId: string,
 *     projectId: string,
 *     value: ProjectAclCacheValue,
 *   ) => void,
 *   invalidateOrganization: (orgId: string) => void,
 *   setEnabled: (enabled: boolean) => void,
 *   size: () => number,
 *   clear: () => void,
 *   isEnabled: () => boolean,
 * }}
 */
export function createProjectAclCache(options = {}) {
  const ttlMs = options.ttlMs ?? PROJECT_ACL_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? PROJECT_ACL_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  let enabled = options.enabled !== false;
  /** @type {Map<string, ProjectAclCacheEntry>} */
  const store = new Map();

  /**
   * @param {string} orgId
   * @param {string} userId
   * @param {string} projectId
   * @returns {string}
   */
  function cacheKey(orgId, userId, projectId) {
    return `${orgId}:${userId}:${projectId}`;
  }

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
     * Returns a cached value when present, unexpired, and matching aclVersion.
     * @param {string} orgId
     * @param {string} userId
     * @param {string} projectId
     * @param {number} aclVersion
     * @returns {ProjectAclCacheValue | undefined}
     */
    get(orgId, userId, projectId, aclVersion) {
      if (!enabled) {
        return undefined;
      }
      const key = cacheKey(orgId, userId, projectId);
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAtMs <= now() || entry.value.aclVersion !== aclVersion) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    /**
     * Stores a resolved ACL value.
     * @param {string} orgId
     * @param {string} userId
     * @param {string} projectId
     * @param {ProjectAclCacheValue} value
     */
    set(orgId, userId, projectId, value) {
      if (!enabled) {
        return;
      }
      evictIfNeeded();
      const key = cacheKey(orgId, userId, projectId);
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }
      store.set(key, {
        value: {
          kind: value.kind,
          permissions: value.permissions ? Object.freeze([...value.permissions]) : undefined,
          aclVersion: value.aclVersion,
        },
        expiresAtMs: now() + ttlMs,
      });
    },

    /**
     * Drops every cached entry for an organization.
     * @param {string} orgId
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
     * Enables or disables the cache (tests disable; production enables).
     * @param {boolean} nextEnabled
     */
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      if (!enabled) {
        store.clear();
      }
    },

    size() {
      return store.size;
    },

    clear() {
      store.clear();
    },

    isEnabled() {
      return enabled;
    },
  };
}

/** Process-wide default cache; enabled for non-test via configureProjectAclCache. */
export const projectAclCache = createProjectAclCache({ enabled: false });

/**
 * Invalidates every cached project ACL entry for an organization.
 * @param {string} orgId Tenant id.
 */
export function invalidateProjectAclCache(orgId) {
  projectAclCache.invalidateOrganization(orgId);
}

/**
 * Applies environment policy to the process-wide project ACL cache.
 * @param {{ isTest: boolean }} env Validated env flags from config.
 */
export function configureProjectAclCache(env) {
  projectAclCache.setEnabled(!env.isTest);
}

/**
 * Increments organization.aclVersion and invalidates the local project ACL cache.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<void>}
 */
export async function bumpProjectAclVersion(orgId, options = {}) {
  await bumpOrganizationAclVersion(orgId, options);
  invalidateProjectAclCache(String(orgId));
}
