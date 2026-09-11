/**
 * Default organization and administrator identity for the startup seed.
 * Named constants — not environment variables.
 */

/** Display name of the first organization. */
export const DEFAULT_ORG_NAME = 'Default Organization';

/** Tenant handle (slug) of the first organization. */
export const DEFAULT_ORG_SLUG = 'default';

/** First administrator email (stored lowercase). */
export const DEFAULT_ADMIN_EMAIL = 'admin@localhost';

/** First administrator display name. */
export const DEFAULT_ADMIN_NAME = 'Administrator';

/**
 * Default plaintext password for the bootstrap administrator (local/MVP).
 * Hashed at seed; change after first login (Phase 08). Never log this value.
 */
export const DEFAULT_ADMIN_PASSWORD = 'abc123';
