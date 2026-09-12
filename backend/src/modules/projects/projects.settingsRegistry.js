/**
 * Project settings key registry — later phases register their keys here.
 */

/** Known setting keys accepted by PATCH /projects/:id/settings (empty in Phase 17). */
export const PROJECT_SETTING_KEYS = Object.freeze([]);

const PROJECT_SETTING_KEY_SET = new Set(PROJECT_SETTING_KEYS);

/**
 * Returns whether `key` is a registered project setting.
 * @param {string} key Candidate setting key.
 * @returns {boolean}
 */
export function isKnownProjectSettingKey(key) {
  return typeof key === 'string' && PROJECT_SETTING_KEY_SET.has(key);
}

/**
 * Validates a settings object against the registry.
 * @param {Record<string, unknown>} settings Candidate settings patch.
 * @returns {{ ok: true } | { ok: false, unknownKeys: string[] }}
 */
export function validateProjectSettingsKeys(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, unknownKeys: ['settings'] };
  }
  const unknownKeys = Object.keys(settings).filter((key) => !isKnownProjectSettingKey(key));
  if (unknownKeys.length > 0) {
    return { ok: false, unknownKeys };
  }
  return { ok: true };
}
