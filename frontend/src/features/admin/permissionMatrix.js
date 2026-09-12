/**
 * Builds matrix rows from the catalog plus unknown keys found on roles.
 * @param {{
 *   groups?: Array<{
 *     id: string,
 *     label: string,
 *     permissions: Array<{ key: string, label: string, description?: string }>,
 *   }>,
 * }} catalog Permissions catalog payload.
 * @param {object[]} roles Role DTOs.
 * @param {string} otherGroupLabel Localized "other" group title.
 * @param {string} unknownPermissionLabel Localized generic permission label.
 * @returns {Array<{
 *   groupId: string,
 *   groupLabel: string,
 *   permissions: Array<{ key: string, label: string, description?: string }>,
 * }>}
 */
export function buildPermissionMatrixRows(
  catalog,
  roles,
  otherGroupLabel,
  unknownPermissionLabel,
) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  /** @type {Map<string, { key: string, label: string, description?: string }>} */
  const knownByKey = new Map();
  for (const group of groups) {
    for (const permission of group.permissions ?? []) {
      knownByKey.set(permission.key, permission);
    }
  }

  /** @type {Set<string>} */
  const unknownKeys = new Set();
  for (const role of roles) {
    for (const key of role.permissions ?? []) {
      if (typeof key === 'string' && key && !knownByKey.has(key)) {
        unknownKeys.add(key);
      }
    }
  }

  const rows = groups.map((group) => ({
    groupId: group.id,
    groupLabel: group.label,
    permissions: [...(group.permissions ?? [])],
  }));

  if (unknownKeys.size > 0) {
    rows.push({
      groupId: 'other',
      groupLabel: otherGroupLabel,
      permissions: [...unknownKeys].sort().map((key) => ({
        key,
        label: unknownPermissionLabel,
      })),
    });
  }

  return rows;
}
