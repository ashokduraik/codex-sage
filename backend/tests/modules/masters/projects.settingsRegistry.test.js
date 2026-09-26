/**
 * Settings registry validation.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_SETTING_KEYS, isKnownProjectSettingKey, validateProjectSettingsKeys } from '../../../src/modules/masters/projects.js';

describe('projects.settingsRegistry', () => {
  it('starts with an empty key registry', () => {
    expect(PROJECT_SETTING_KEYS).toEqual([]);
    expect(isKnownProjectSettingKey('anything')).toBe(false);
  });

  it('accepts an empty settings object', () => {
    expect(validateProjectSettingsKeys({})).toEqual({ ok: true });
  });

  it('rejects unknown keys', () => {
    expect(validateProjectSettingsKeys({ foo: 1 })).toEqual({
      ok: false,
      unknownKeys: ['foo'],
    });
  });

  it('rejects non-object settings', () => {
    expect(validateProjectSettingsKeys(/** @type {any} */ (null)).ok).toBe(false);
    expect(validateProjectSettingsKeys(/** @type {any} */ ([])).ok).toBe(false);
  });
});
